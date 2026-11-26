/**
 * chronicle/extract — 从群消息流里提炼「够格成为共同记忆」的事件簇（R7.1）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么先做这一层（而不是直接丢给 LLM 判断「什么重要」）
 *
 *   R7.1 方案 §3「明确不做」写得很直白：
 *     · 记录每条消息进群史 → 那是日志不是记忆
 *     · 用 LLM 判断「这件事重不重要」→ 贵且不稳定
 *
 *   所以重要性判定走**纯算法 + 可观测信号**：参与人数 / 持续时长 / 情绪高点。
 *   本文件是整条流水线的地基：它错了，后面入账、编年史、`/群史` 全是脏的，
 *   而且**不会抛错**（簇少了、分数偏了，界面上只是「群史很薄」）——
 *   正是本项目反复踩的「静默失败」类型。所以它必须：
 *
 *     · 纯函数：无 IO、无 Date.now()、无 Math.random()、无全局可变状态
 *     · 同样的输入永远给同样的输出（含 id），否则 appendEvents 的幂等就失效
 *     · 坏输入降级成空结果 / 跳过，但**在 stats.warnings 里留痕**，绝不静默
 *
 * ── 判据（R7.1 §4.2，不猜）───────────────────────────────────────────────
 *
 *   聚类：相邻两条消息间隔 > 30 分钟 → 断开成新簇
 *   打分：参与人数 ≥ 3        → +40
 *         持续时长 ≥ 30 分钟   → +30
 *         情绪高点 peak ∈[0,1] → peak × 30
 *   够格：总分 ≥ 60（即「至少占两条信号」才有资格成为共同记忆）
 *
 * ── 情绪高点为什么是「密度」而不是「最热的一条」──────────────────────────
 *
 *   逐条累加信号后按条数归一化（方案 §4.2 的公式）：
 *     raw = Σ 单条信号（!! ≥2 → 0.2 / emoji ≥2 → 0.2 / 全文 >50 字 → 0.1）
 *     peak = min(1, raw / 条数 × 3)
 *
 *   这会让「长而平淡的刷屏」被稀释掉 —— 这是有意的：否则 200 条里有一句
 *   「卧槽！！」就能靠体量骗到满分，群史里会塞满无意义的日常。
 *
 * ── 隐私 ──────────────────────────────────────────────────────────────────
 *
 *   ❌ 本模块**不使用昵称** `n`：昵称随时可改，且任何对外文本都不该带昵称。
 *   ✅ 返回值里的 participants 是 openid 数组（账本用途，R7.1 §4.1），
 *      但**任何面向用户的文本（prompt / chronicle.md / 命令回显）都不得出现它**，
 *      渲染那一层见 narrative.mjs。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 聚类窗口：相邻消息间隔超过它就断簇（30 分钟）。 */
export const DEFAULT_GAP_MS = 30 * 60 * 1000;
/** 够格分数线。 */
export const DEFAULT_QUALIFY_SCORE = 60;
/** 参与人数达到几人算「一群人」而不是「两个人聊天」。 */
export const MIN_PARTICIPANTS = 3;
/** 持续多久算「这件事持续发生过」。 */
export const MIN_DURATION_MS = 30 * 60 * 1000;

/** 三项加分。 */
const BONUS_PARTICIPANTS = 40;
const BONUS_DURATION = 30;
const MAX_EMOTION_BONUS = 30;

/** 单条消息的情绪信号权重。 */
const SIG_BANG = 0.2;
const SIG_EMOJI = 0.2;
const SIG_LONG = 0.1;
/** 超过多少字算「认真写了」（按 Unicode 码点计，不看 UTF-16 单元）。 */
const LONG_TEXT_CHARS = 50;
/** 情绪信号密度放大系数（方案 §4.2）。 */
const EMOTION_GAIN = 3;

/** 连续两个及以上感叹号（中英文都算）。 */
const BANG_RE = /[!！]{2,}/;

/**
 * emoji 判定。
 *
 * 只覆盖真正的 emoji 区段，刻意**不含** `【表情: 比心】` 这类 QQ 表情占位符：
 * 占位符是上游的格式标记，几乎每条都有，统计它等于让「表情密集」恒为真。
 *
 * U+FE0F（变体选择符）也不算，否则「❤️」会被当成两个 emoji。
 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;

/** 机器人自己的 sender 标识：不算「群友参与」，否则几乎每个簇都自动满 3 人。 */
const BOT_SENDERS = new Set(['self', 'robot', 'bot']);

/**
 * 32 位十六进制 openid。
 *
 * 前后都加 hex 边界（lookaround），避免把更长的十六进制串
 * （如 msgId 里的长 hex 段）切出一个假的 32 位命中 —— 那样会替错位置，
 * 反而把不是 openid 的东西改写掉。
 */
const OPENID_HEX_RE = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])/g;

/** 「哪一天」统一按东八区算。 */
const DEFAULT_TZ_OFFSET_MIN = 8 * 60;

/* ──────────────────────────────────────────────────────────────
 * 小工具（全部纯函数）
 * ────────────────────────────────────────────────────────────── */

/** 按码点计长度（`[...'😭'].length === 1`，不会把 emoji 算成 2）。 */
function charLen(text) {
  return [...String(text ?? '')].length;
}

/** 保留 4 位小数，抹掉 0.6000000000000001 这类浮点毛刺。 */
function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/** 保留 2 位小数。 */
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** 取正的有限数，非法回落默认值。 */
function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 取有限数（允许 0 / 负数），非法回落默认值。 */
function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 时间戳 → 本地日期 `YYYY-MM-DD`。
 *
 * 为什么把时区偏移做成参数（默认东八区）而不是用 `getFullYear()`：
 * 纯函数不能依赖宿主 TZ。宿主跑在 UTC 的手机/服务器上时，晚 8 点以后的
 * 事件会被算到「明天」或「今天」，同一件事在两次运行里落到不同日期，
 * 于是同一天出现两行群史（实测容易发生在北京时间 00:00~08:00）。
 */
function dateOf(ms, offsetMin) {
  const d = new Date(Number(ms) + Number(offsetMin) * 60000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 数一条消息里的 emoji 个数（`match` 自带 /g 时不吃 lastIndex）。 */
function countEmoji(text) {
  const m = String(text ?? '').match(EMOJI_RE);
  return m ? m.length : 0;
}

/**
 * 把文本里的 32 位 hex openid 换成「某位群友」代称（纯函数，红线 2）。
 *
 * 为什么放在本文件（纯函数层）而不是 store：
 *   prompt 和 chronicle.md 两条出口都要用，把它留在纯函数层可以单测，
 *   且 store 那边只需 import 一次；两边各写一套正则迟早不一致。
 *
 * @param {string} text
 * @param {string} [replacement]
 * @returns {{ text: string, redacted: number }} redacted = 替换了几处（供 diag 留痕）
 */
export function redactOpenids(text, replacement = '某位群友') {
  const src = typeof text === 'string' ? text : String(text ?? '');
  if (!src) return { text: '', redacted: 0 };
  let redacted = 0;
  const out = src.replace(OPENID_HEX_RE, () => {
    redacted += 1;
    return replacement;
  });
  return { text: out, redacted };
}

/* ──────────────────────────────────────────────────────────────
 * 情绪高点（导出以便单测逐条验证信号）
 * ────────────────────────────────────────────────────────────── */

/**
 * 算一个簇的情绪高点，返回 0~1。
 *
 * @param {Array<{ x?: string }>} messages 同一簇的消息（顺序无关）
 * @returns {number} 0 = 全程平淡，1 = 情绪拉满
 */
export function emotionPeakOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return 0;

  let raw = 0;
  for (const m of list) {
    const text = String(m?.x ?? '');
    let s = 0;
    if (BANG_RE.test(text)) s += SIG_BANG;          // 连续感叹
    if (countEmoji(text) >= 2) s += SIG_EMOJI;      // 表情密集
    if (charLen(text) > LONG_TEXT_CHARS) s += SIG_LONG; // 长文（认真了）
    raw += s;
  }

  const peak = Math.min(1, (raw / list.length) * EMOTION_GAIN);
  return round4(peak);
}

/* ──────────────────────────────────────────────────────────────
 * 归一化输入 / 聚类
 * ────────────────────────────────────────────────────────────── */

/**
 * 归一化一条消息。非法（不是对象 / 没有可用时间戳）返回 null。
 *
 * 只保留打分要用的三个字段；`n`（昵称）故意丢弃 —— 见文件头「隐私」。
 */
function normalizeOne(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = Number(raw.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  return {
    s: String(raw.s ?? '').trim(),
    x: typeof raw.x === 'string' ? raw.x : '',
    t,
  };
}

/**
 * 按时间排序后按「间隔 > gapMs 断开」切簇。
 *
 * 注意是**严格大于**：间隔正好 30 分钟不断开。方案写的就是「> 30 分钟断开」，
 * 边界上宁可合并不肯拆 —— 拆开会把一件事记成两件，比合并更难纠正
 * （合并了还能在 events.jsonl 里人工删，拆了要靠人回忆补）。
 */
function clusterMessages(list, gapMs) {
  const clusters = [];
  let cur = null;
  for (const m of list) {
    if (cur && m.t - cur.endAt <= gapMs) {
      cur.msgs.push(m);
      cur.endAt = m.t;
      continue;
    }
    cur = { startAt: m.t, endAt: m.t, msgs: [m] };
    clusters.push(cur);
  }
  return clusters;
}

/* ──────────────────────────────────────────────────────────────
 * 主入口
 * ────────────────────────────────────────────────────────────── */

/**
 * 提取事件簇，并附带诊断统计（供 hook 写 chronicle-diag.log）。
 *
 * ⚠️ 调用方拿它来「留痕」：warnings 非空说明输入有坏数据，
 *    必须落盘，否则又是「功能正常但结果为空」的静默失败。
 *
 * @param {Array<{s?:string,n?:string,t?:number,x?:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.gapMs]             聚类窗口（默认 30 分钟）
 * @param {number} [opts.qualifyScore]      够格分数线（默认 60）
 * @param {number} [opts.tzOffsetMinutes]   「哪一天」的时区偏移（默认 +480 = 东八区）
 * @returns {{ events: Array<object>, stats: object }}
 */
export function extractEventsDetailed(messages, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const gapMs = positive(o.gapMs, DEFAULT_GAP_MS);
  const qualifyScore = finiteOr(o.qualifyScore, DEFAULT_QUALIFY_SCORE);
  const tzOffset = finiteOr(o.tzOffsetMinutes, DEFAULT_TZ_OFFSET_MIN);

  const stats = {
    input: 0,
    usable: 0,
    skipped: 0,
    clusters: 0,
    qualified: 0,
    warnings: [],
  };

  if (!Array.isArray(messages)) {
    stats.warnings.push('input-not-array');
    return { events: [], stats };
  }
  stats.input = messages.length;
  if (!messages.length) return { events: [], stats };

  // ① 归一化 + 排序（时间升序；同时间保持原相对顺序，sort 稳定）
  const list = [];
  for (const raw of messages) {
    const m = normalizeOne(raw);
    if (!m) { stats.skipped += 1; continue; }
    list.push(m);
  }
  stats.usable = list.length;
  if (stats.skipped) stats.warnings.push(`skip-invalid-${stats.skipped}`);
  if (!list.length) return { events: [], stats };

  list.sort((a, b) => a.t - b.t);

  // ② 聚类
  const clusters = clusterMessages(list, gapMs);
  stats.clusters = clusters.length;

  // ③ 逐个打分。id 的序号按「同一天内的时间顺序」分配 ⇒ 重跑同一批消息得到的 id 不变，
  //    这是 appendEvents 幂等的前提（id 一变就会重复追加，群史里出现双份）。
  const seqByDate = new Map();
  const events = [];

  for (const c of clusters) {
    const date = dateOf(c.startAt, tzOffset);
    const seq = (seqByDate.get(date) || 0) + 1;
    seqByDate.set(date, seq);

    // 参与者：去重 + 排序（保证确定性），机器人自己不算群友
    const people = new Set();
    for (const m of c.msgs) {
      if (!m.s || BOT_SENDERS.has(m.s.toLowerCase())) continue;
      people.add(m.s);
    }
    const participants = [...people].sort();

    const durationMs = c.endAt - c.startAt;
    const emotionPeak = emotionPeakOf(c.msgs);

    let score = 0;
    if (participants.length >= MIN_PARTICIPANTS) score += BONUS_PARTICIPANTS;
    if (durationMs >= MIN_DURATION_MS) score += BONUS_DURATION;
    score += emotionPeak * MAX_EMOTION_BONUS;
    score = round2(score);

    const event = {
      id: `evt-${date.replace(/-/g, '')}-${seq}`,
      date,
      startAt: c.startAt,
      endAt: c.endAt,
      participants,
      msgCount: c.msgs.length,
      emotionPeak,
      score,
      qualified: score >= qualifyScore,
    };
    if (event.qualified) stats.qualified += 1;
    events.push(event);
  }

  return { events, stats };
}

/**
 * 提取事件簇（主入口，纯函数）。
 *
 * 返回值里每条事件：
 *   { id, date, startAt, endAt, participants, msgCount, emotionPeak, score, qualified }
 *
 * 过滤（`qualified` 为 false 的）由调用方决定 —— 本函数全量返回，
 * 因为「不够格」的簇在调试「群史为什么这么薄」时同样有价值。
 *
 * @param {Array<{s?:string,n?:string,t?:number,x?:string}>} messages
 * @param {object} [opts] 见 extractEventsDetailed
 * @returns {Array<object>} 时间升序的事件数组；坏输入返回 []
 */
export function extractEvents(messages, opts = {}) {
  return extractEventsDetailed(messages, opts).events;
}

export default {
  DEFAULT_GAP_MS,
  DEFAULT_QUALIFY_SCORE,
  MIN_PARTICIPANTS,
  MIN_DURATION_MS,
  redactOpenids,
  emotionPeakOf,
  extractEvents,
  extractEventsDetailed,
};
