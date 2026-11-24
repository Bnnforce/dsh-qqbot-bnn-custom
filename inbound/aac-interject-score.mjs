/**
 * interject-score — 接话打分（**默认关闭，log 模式绝不拦截**）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 要解决的问题
 *
 *   群里刷屏时，她应该判断"这话跟我有关吗" —— 不相关就**一次模型都不调**，
 *   省 token 也不打扰。
 *
 * ── 三条铁律（子智能体用例反复强调，缺一不可）────────────────────────────
 *
 *   ① **默认关闭**（enabled: false）
 *      默认开 = 上线第一天就拿没调过的阈值决定她说不说。
 *
 *   ② **log 模式绝不拦截**
 *      log 与 enforce 的差别**只能是"是否拦截"**，判分逻辑完全共用。
 *      没有 log 期就拿不到真实分数分布，只能盲调阈值。
 *
 *   ③ **被 @ / 叫名字 无条件短路**
 *      这是不可调的产品底线（角色卡 P0M「被@必回」）。
 *      绝不能让可调阈值压过它 —— 一次手滑就违反角色卡。
 *
 * ── 还有两条（来自本项目历史故障模式）────────────────────────────────────
 *
 *   ④ **异常必须 fail-open**：打分抛错 → 放行 + warn。
 *      fail-closed 会在依赖出问题时把她的嘴彻底封上，且现场无感知。
 *
 *   ⑤ **日志不落全文**：只落 ≤30 字摘要，避免审计日志变成泄漏源
 *      （与 privacy-guard 的纪律冲突）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { addressed } from '../lib/name.mjs';

export const name = 'interject-score';

const LOG_FILE = join(EXT_DATA, 'interject-score.jsonl');
const CONFIG_FILE = join(EXT_DATA, 'interject-config.json');
const ROTATE_BYTES = 256 * 1024;
const STATE_KEY = Symbol.for('qqbot.interject-state.v1');

const DEFAULTS = {
  enabled: false,            // ★ 默认关闭
  mode: 'log',               // log（只记录）| enforce（真拦截）
  threshold: 0.5,
  /** 各维度权重（和为 1）。 */
  wAsk: 0.4,
  wMention: 0.3,
  wTopic: 0.2,
  wNovelty: 0.1,
  /** 近多少条算"当前话题"。 */
  topicWindow: 20,
  /** 近多少条算"她刚说过"。 */
  noveltyWindow: 10,
  /** 她参与过的话题词缓存上限。 */
  maxTopicWords: 40,
  /** ★ 2026-11-24 R6.4：情绪是否参与接话决策（默认关）。 */
  moodBiasEnabled: false,
  /** 情绪微调幅度上限（±0.1，绝不压过被@必回）。 */
  moodBiasMax: 0.1,
};

function readJson(p, fb) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? fb; } catch { return fb; }
}

function config() {
  try {
    const c = readJson(CONFIG_FILE, null);
    return { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 进程内状态：每群的最近消息（只存短文本 + 是否提到她）。 */
function state() {
  let m = globalThis[STATE_KEY];
  if (!(m instanceof Map)) { m = new Map(); globalThis[STATE_KEY] = m; }
  return m;
}

/** 常见疑问信号。 */
const ASK_HINTS = ['吗', '呢', '怎么', '为什么', '为啥', '是不是', '要不要', '能不能', '可以吗', '哪个', '多少', '怎么样'];
/** 中文虚词（用于提取话题词时过滤）。 */
const STOP = new Set('的了是在我你他她它们这那有和就都也不没很太又再还只把被让给对从向到与及或但而如果因为所以于之其'.split(''));

/** 提取"有信息量"的词：2 字以上的汉字串 + 英文词。 */
export function topicWords(text) {
  const t = String(text ?? '');
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const en = t.match(/[A-Za-z][A-Za-z0-9_]{1,}/g) ?? [];
  const out = [];
  for (const seg of zh) {
    // 2-4 字滑窗，过滤含虚词的
    for (let i = 0; i + 2 <= seg.length; i += 1) {
      const w = seg.slice(i, i + 2);
      if ([...w].every((c) => STOP.has(c))) continue;
      out.push(w);
    }
  }
  for (const w of en) out.push(w.toLowerCase());
  return [...new Set(out)];
}

/**
 * ★ 2026-11-24 R6.4：情绪偏移（纯函数）。
 *
 * 把她的当前情绪折算成一个接话意愿偏移，范围 [-moodBiasMax, +moodBiasMax]。
 *
 * 维度映射（都来自 mood 八维，值域 0~1，中性 0.5）：
 *   energy 低（累）        → 负偏移（不想接话）
 *   connection 高（想说话） → 正偏移
 *   patience 低（没耐心）   → 负偏移
 *   mood 高（心情好）       → 小幅正偏移
 *
 * 安全边界：只做**微调**，绝不压过"被@必回"（那条在打分之前短路）。
 *
 * @param {object|null} mood {energy, connection, patience, mood}
 * @param {number} max
 * @returns {number} 偏移量，[-max, +max]
 */
export function moodBias(mood, max = 0.1) {
  if (!mood || typeof mood !== 'object') return 0;
  const m = Math.max(0, Math.min(0.5, Number(max) || 0.1));
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0.5;
  };
  const energy = n(mood.energy);
  const connection = n(mood.connection);
  const patience = n(mood.patience);
  const moodV = n(mood.mood);

  // 各维度相对中性的偏移，乘系数后叠加，最后 clamp 到 [-m, +m]
  let bias = 0;
  bias += (energy - 0.5) * 0.4;        // 累 → 不想说
  bias += (connection - 0.5) * 0.4;    // 想说话 → 想接
  bias += (patience - 0.5) * 0.3;      // 没耐心 → 不想说
  bias += (moodV - 0.5) * 0.2;         // 心情好 → 想接
  return Math.max(-m, Math.min(m, bias));
}

/**
 * ★ 2026-11-24 R6.4：读她当前的八维情绪（跨体系，直接读文件）。
 *
 * 插件 dsh-bnnbotbox 把情绪状态写到 `{DSH_HOME}/data/dsh-anti-ai-persona/state/mood-axes.json`。
 * 扩展包与插件是两套加载体系不能互相 import，这里按既有约定（slang-inline / trim-agent-tools
 * 同款路径）直接读文件。
 *
 * 只读一次、失败静默返回 null（调用方会当"无情绪"处理，偏移为 0）。
 */
function readMood() {
  try {
    // ⚠️ DSH_HOME 已含 `.dsh`；fallback 到 homedir() 时才拼 `.dsh`
    const home = process.env.DSH_HOME || process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home';
    const p = process.env.DSH_HOME
      ? join(home, 'data', 'dsh-anti-ai-persona', 'state', 'mood-axes.json')
      : join(home, '.dsh', 'data', 'dsh-anti-ai-persona', 'state', 'mood-axes.json');
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * 打分（纯函数，好测）。
 *
 * @param {object} input
 * @param {string} input.text         本条消息
 * @param {string[]} [input.recent]   最近 N 条群消息
 * @param {string[]} [input.herWords] 她最近说过的内容
 * @param {string[]} [input.names]    她的名字/别名
 * @param {object|null} [input.mood]  ★ R6.4：当前情绪（{energy,connection,patience,mood}）
 * @param {object} [cfg]
 * @returns {{ score:number, dims:object, decision:string, moodBias:number }}
 */
export function score(input, cfgIn = DEFAULTS) {
  // ⚠️ 2026-11-24 修（实测抓到）：原来 `cfg = DEFAULTS` 只在**参数省略**时生效。
  //   调用方传 {} 时所有权重都是 undefined ⇒ score 恒为 0，等于接话打分完全失效。
  //   必须在这里合并默认值。
  const cfg = { ...DEFAULTS, ...(cfgIn && typeof cfgIn === 'object' ? cfgIn : {}) };
  const text = String(input?.text ?? '');
  const recent = Array.isArray(input?.recent) ? input.recent : [];
  const herWords = Array.isArray(input?.herWords) ? input.herWords : [];
  const names = Array.isArray(input?.names) ? input.names.filter(Boolean) : [];

  // ── 维度1：像在问人 ──
  const ask = ASK_HINTS.some((h) => text.includes(h)) ? 1 : 0;

  // ── 维度2：提到她 ──
  const mention = names.some((n) => text.includes(n)) ? 1 : 0;

  // ── 维度3：话题相关（与最近消息的关键词重合） ──
  const cur = new Set(topicWords(text));
  const topicSet = new Set();
  for (const r of recent.slice(-(Number(cfg.topicWindow) || 20))) {
    for (const w of topicWords(r)) topicSet.add(w);
  }
  let topic = 0;
  if (cur.size && topicSet.size) {
    let hit = 0;
    for (const w of cur) if (topicSet.has(w)) hit += 1;
    topic = Math.min(1, hit / Math.max(3, Math.min(cur.size, 6)));
  }

  // ── 维度4：不重复（她最近说过的不算新话题） ──
  const herSet = new Set();
  for (const h of herWords.slice(-(Number(cfg.noveltyWindow) || 10))) {
    for (const w of topicWords(h)) herSet.add(w);
  }
  let novelty = 1;
  if (cur.size && herSet.size) {
    let same = 0;
    for (const w of cur) if (herSet.has(w)) same += 1;
    novelty = Math.max(0, 1 - same / Math.max(1, cur.size));
  }

  const dims = { ask, mention, topic, novelty };
  const baseScore =
    ask * (Number(cfg.wAsk) || 0) +
    mention * (Number(cfg.wMention) || 0) +
    topic * (Number(cfg.wTopic) || 0) +
    novelty * (Number(cfg.wNovelty) || 0);

  // ★ R6.4：情绪偏移（默认关；关时偏移为 0，行为与改动前逐字节一致）
  const bias = cfg.moodBiasEnabled === true
    ? moodBias(input?.mood, cfg.moodBiasMax)
    : 0;

  const scoreV = Math.max(0, Math.min(1, baseScore + bias));

  // 阈值允许 0（=全部唤醒）：不能用 || ，0 会被当成假值退回 0.5
  const th = Number(cfg.threshold);
  const threshold = Number.isFinite(th) ? th : 0.5;
  return {
    score: Math.round(scoreV * 1000) / 1000,
    dims,
    decision: scoreV >= threshold ? 'wake' : 'silent',
    moodBias: Math.round(bias * 1000) / 1000,
  };
}

/** 轮转写日志。 */
function logRow(row) {
  try {
    mkdirSync(EXT_DATA, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > ROTATE_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* 不存在 */ }
    appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`, 'utf8');
  } catch { /* 日志失败绝不影响主链 */ }
}

function gidOf(ctx) {
  const p = ctx?.peer ?? {};
  return String(p.peerId || p.groupId || ctx?.groupId || '').trim();
}

export async function onInbound(ctx, next) {
  let cfg;
  try {
    cfg = config();
  } catch {
    return next();
  }

  // ★ 铁律①：默认关闭 → 完全等同改动前
  if (cfg.enabled !== true) return next();
  if (String(ctx?.scope ?? '') !== 'group') return next();

  // ★ 铁律③：被 @ / 叫名字 → 无条件短路（不可调的产品底线）
  try {
    if (addressed(ctx)) return next();
  } catch {
    return next();     // 判不出来 → 放行（fail-open）
  }

  const gid = gidOf(ctx);
  const uid = String(ctx?.sender?.openid ?? ctx?.message?.senderId ?? '').trim();
  const text = String(ctx?.text ?? '').trim();

  // ★ 铁律⑤：日志只留摘要
  try {
    const m = state();
    const bucket = m.get(gid) ?? { recent: [], her: [] };
    const r = score(
      {
        text,
        recent: bucket.recent,
        herWords: bucket.her,
        // ★ R6.4：情绪只用于接话决策（不注入正文），且只在 moodBiasEnabled=true 时读
        mood: cfg.moodBiasEnabled === true ? readMood() : null,
      },
      cfg,
    );

    logRow({
      at: new Date().toISOString(),
      peer: gid,
      uid,
      score: r.score,
      dims: r.dims,
      threshold: Number(cfg.threshold) || 0.5,
      mode: cfg.mode,
      decision: r.decision,
      // 只留 30 字摘要，不落全文
      excerpt: text.slice(0, 30),
    });

    // 记忆最近的群消息（有上限）
    bucket.recent.push(text.slice(0, 60));
    const tw = Number(cfg.topicWindow) || 20;
    if (bucket.recent.length > tw) bucket.recent = bucket.recent.slice(-tw);
    m.set(gid, bucket);

    // ★ 铁律②：log 模式绝不拦截
    if (cfg.mode === 'enforce' && r.decision === 'silent') {
      try { await ctx.annihilate?.({ reason: 'interject-score: 与当前话题无关', ownerAck: false }); } catch { /* ignore */ }
      return;
    }
  } catch (e) {
    // ★ 铁律④：异常 fail-open —— 放行 + warn，绝不被封嘴
    try { ctx?.note?.(`interject-score 异常已放行：${String(e?.message ?? e).slice(0, 40)}`); } catch { /* ignore */ }
    return next();
  }

  return next();
}

export default { name, onInbound, score, topicWords };
