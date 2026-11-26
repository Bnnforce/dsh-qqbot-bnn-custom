/**
 * diary-task — 每天固定时间（默认 22:30）给每个活跃群写一篇日记（R6.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 做什么
 *
 *   每天 22:30（可配 diaryHour / diaryMinute）后，对每个「今天有聊天的群」
 *   读它今天的聊天记录 → 脱敏 → 调 LLM 写一篇「她视角」的日记 → 落盘到
 *   `人格/日记/<人格>/<群id前8位>/<日期>.md`。
 *
 * ── 群隔离（硬约束）──────────────────────────────────────────────────────
 *
 *   每个群只读自己的 `msg-history/group_<gid>/<date>.jsonl`，
 *   绝不读别的群。日记文件也按群分目录。
 *
 * ── 日界任务（照抄 birthday-auto 的模式）──────────────────────────────────
 *
 *   节律 5 分钟轮询；到点且「今天还没写」才写；重启后若已过点且没写 → 补写。
 *   按 `state.last[gid:date]` 去重，多扫几次不会重复写。
 *
 * ── 失败降级 ─────────────────────────────────────────────────────────────
 *
 *   · LLM 挂了 / 超时 / 无模型 → 写一篇占位日记「今天没写成日记」，不崩
 *   · 群今天没聊天 → 跳过（不写空日记）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPersona } from '../lib/io/persona-store.mjs';
import { currentPersonaOf } from '../lib/io/persona-path.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { generateDiary } from '../lib/diary/llm.mjs';
import { writeDiary, readDiary, ymdOf } from '../lib/diary/store.mjs';
import { readGroupEvents } from '../lib/diary/group-history.mjs';

export const name = 'diary-task';

const TZ = 'Asia/Shanghai';
const DEFAULT_HOUR = 22;
const DEFAULT_MINUTE = 30;
const FALLBACK_MS = 300_000;
const STATE_NAME = 'diary-state.json';
const CONFIG_NAME = 'diary-config.json';

function dataRootOf(env) {
  return String(env?.dataRoot || env?.caps?.dataRoot || '').trim();
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) ?? fallback; } catch { return fallback; }
}

function writeJson(file, obj) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function configOf(root) {
  return readJson(join(root, '.qqbot-extensions', 'data', CONFIG_NAME), {});
}

function zonedParts(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

function groupsRoot(root) {
  return join(root, '.qqbot', 'msg-history');
}

function groupDirs(root) {
  try {
    return readdirSync(groupsRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('group_'))
      .map((e) => e.name.replace(/^group_/, ''));
  } catch { return []; }
}

function personaNameOfGroup(gid) {
  try {
    const name = currentPersonaOf({ peer: { peerId: String(gid || ''), scope: 'group' } });
    if (name) return name;
  } catch { /* 回落默认 */ }
  try { return defaultPersona()?.name || '当前人格'; } catch { return '当前人格'; }
}

/** 某群今天是否真有聊天记录（有没有可写的素材）。 */
function groupHasChatToday(root, gid, date) {
  try {
    const p = join(groupsRoot(root), `group_${gid}`, `${date}.jsonl`);
    return !!readFileSync(p, 'utf8').trim();
  } catch { return false; }
}

/** 占位日记（LLM 失败时）。 */
function placeholderDiary(persona) {
  return [
    `（今天${persona}没能写成日记。）`,
    '',
    '可能是忙，也可能只是忘了。明天再写吧。',
  ].join('\n');
}

/** 可单测：到点后逐群写日记。 */
/** 日记唤醒诊断（只写本地日志，失败静默）。 */
function diagDiary(event, gid, date, detail = '') {
  try {
    const file = join(EXT_DATA, 'diary-diag.log');
    mkdirSync(dirname(file), { recursive: true });
    const tail = detail ? ' ' + detail : '';
    const line = new Date().toISOString() + ' [diary] ' + event + ' ' + String(gid).slice(0, 8) + ' ' + date + tail + '\n';
    writeFileSync(file, line, { flag: 'a' });
  } catch { /* 日志失败不影响主流程 */ }
}

/**
 * 构造「让宿主写日记」的提示词。
 *
 * 为什么不是自己调 LLM：扩展 hook 的 ctx 够不到 llm 服务（见调用处注释）。
 * 我们把当天的事件摘要交给宿主，由 AI 带着完整人格写。
 */
function buildDiaryWakePrompt(persona, events, date) {
  const out = [];
  out.push('（系统触发：请为 ' + date + ' 写一篇日记）');
  out.push('');
  out.push('你是' + (persona || '爱莉希雅') + '。把今天群里发生的事，用你自己的口吻写成一篇日记。');
  out.push('要求：自然、不煽情、不刻意，像睡前随手写的。150 字以内。只输出日记正文，不要标题、不要解释。');
  if (Array.isArray(events) && events.length) {
    out.push('', '今天发生的事（素材，供参考）：');
    for (const e of events.slice(0, 12)) {
      const t = typeof e === 'string' ? e : (e && (e.text || e.summary)) || '';
      if (t) out.push('- ' + String(t).slice(0, 80));
    }
  } else {
    out.push('', '今天群里比较安静，没什么特别的事。');
  }
  return out.join('\n');
}

export async function checkAndWrite(env, now = new Date()) {
  const root = dataRootOf(env);
  if (!root) return { ok: false, reason: 'no-data-root', results: [] };

  const cfg = configOf(root);
  const hour = Number.isFinite(Number(cfg.diaryHour)) ? Number(cfg.diaryHour) : DEFAULT_HOUR;
  const minute = Number.isFinite(Number(cfg.diaryMinute)) ? Number(cfg.diaryMinute) : DEFAULT_MINUTE;

  const ymd = zonedParts(now);
  // 到点判定：小时+分钟都过了才写
  if (ymd.h < hour || (ymd.h === hour && ymd.min < minute)) {
    return { ok: false, reason: 'not-time', results: [] };
  }

  const date = `${ymd.y}-${String(ymd.m).padStart(2, '0')}-${String(ymd.d).padStart(2, '0')}`;
  const stateFile = join(root, '.qqbot-extensions', 'data', STATE_NAME);
  const state = readJson(stateFile, {});
  if (!state.last || typeof state.last !== 'object') state.last = {};

  const results = [];
  let wrote = 0;

  for (const gid of groupDirs(root)) {
    const key = `${gid}:${date}`;
    if (state.last[key]) { results.push({ gid, status: 'already' }); continue; }

    // 今天没聊天 → 不写（避免空日记）
    if (!groupHasChatToday(root, gid, date)) { results.push({ gid, status: 'no-chat' }); continue; }

    const persona = personaNameOfGroup(gid);

    // 读本群今日聊天 + 脱敏
    const events = readGroupEvents(root, gid, date, { maxEvents: 60 });

    // 调 LLM 写日记（失败 → 占位）
    // ★ 2026-11-25 修：svcOf 要的是带 kernel/caps 的服务容器，它在 env.ctx 上，
    //   不是 env 本身。这里传 env.ctx，llm.mjs 里还有一层下钻兜底。
    let content = null;
    try {
      // ★ 2026-11-26 诊断：记录 env 真实形状，定位「no-llm」为何持续失败。
      try {
        const { appendFileSync: _ap, mkdirSync: _mk } = await import('node:fs');
        const { join: _j } = await import('node:path');
        const { EXT_DATA: _ed } = await import('../lib/pack-paths.mjs');
        _mk(_ed, { recursive: true });
        _ap(_j(_ed, 'diary-env-probe.log'), JSON.stringify({
          at: new Date().toISOString(),
          envType: typeof env,
          envKeys: env && typeof env === 'object' ? Object.keys(env).slice(0, 25) : [],
          hasEnvCtx: Boolean(env?.ctx),
          ctxType: typeof env?.ctx,
          ctxKeys: env?.ctx && typeof env.ctx === 'object' ? Object.keys(env.ctx).slice(0, 25) : [],
          ctxHasGet: typeof env?.ctx?.get === 'function',
          capsHasKernel: Boolean(env?.caps?.kernel),
          capsKernelGet: typeof env?.caps?.kernel?.get === 'function',
        }) + '\n', 'utf8');
      } catch { /* 探针失败不影响主流程 */ }
      content = await generateDiary({ ctx: env?.ctx ?? env, persona, events, meta: { date, timeoutMs: 20_000 } });
    } catch { content = null; }
      // ★★ 2026-11-26 架构修正（真根因）：扩展 hook 的 ctx 够不到 llm。
      //   cordis 的 ctx.get(name) 只在本 ctx 所属 fiber 树里找（cordis _getImpl）。
      //   扩展 hook 拿到的是 qqbot 插件的子 ctx（env.ctx === caps.kernel === opts.ctx），
      //   其 store 里没有 llm（llm 由 dsh-llm 在另一条 fiber 分支提供）⇒ 恒 undefined。
      //   与 memoir 2026-11-21 的结论一致（连修 6 轮后改为「让宿主生成」）。
      //
      //   正确方案：用宿主提供的 env.wakeTo(scope, peerId, text)。
      //   它把一条消息注入指定会话，AI 带着完整人格+上下文自己写并回复到 QQ。
      //   ⇒ LLM 调用是宿主的事。
      if (!content || !content.trim()) {
        const wakeTo = env?.wakeTo;
        let woken = false;
        if (typeof wakeTo === 'function') {
          try {
            const prompt = buildDiaryWakePrompt(persona, events, date);
            woken = (await wakeTo('group', gid, prompt)) !== false;
            if (woken) diagDiary('wake-sent', gid, date);
          } catch (e) {
            diagDiary('wake-throw', gid, date, e instanceof Error ? e.message : String(e));
          }
        }
        if (!woken) {
          diagDiary('wake-unavailable', gid, date);
          content = placeholderDiary(persona);
        }
      }

    // wake 已发出：日记正文由宿主在正常回合里生成并回复。
    // 我们这边不写占位、也不记账（避免留下假日记 + 阻塞明天重试）。
    if (content === null) {
      // ★ 必须记账，否则下一拍 tick 还会认为「今天没写」⇒ 重复唤醒刷屏。
      state.last[key] = new Date().toISOString();
      results.push({ gid, persona, status: "woken" });
      writeJson(stateFile, state);
      continue;
    }

    // 落盘（原子写）
    // 防御：content 必须是字符串（历史上出过写入字面量 null 的事故）。
    if (typeof content !== "string" || !content.trim()) {
      results.push({ gid, persona, status: "empty-content" });
      continue;
    }
    const ok = writeDiary(persona, gid, date, content + '\n', env?.logger);
    if (ok) {
      state.last[key] = new Date().toISOString();
      wrote += 1;
      results.push({ gid, persona, status: 'written', len: content.length });
    } else {
      results.push({ gid, persona, status: 'write-failed' });
    }
  }

  if (wrote) writeJson(stateFile, state);
  return { ok: wrote > 0, reason: wrote ? 'written' : (results.length ? 'none-written' : 'no-group'), results };
}

export async function run(env) {
  const tick = async () => {
    try { await checkAndWrite(env); } catch { /* ignore */ }
  };

  // ① 启动即检查：重启后若已过点且今天没写 → 立刻补写
  await tick();

  // ② 节律交给中央调度器（日界任务，5 分钟轮询，按日去重）
  registerWithFallback('diary-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'diary-task', meta: { id: 'ext-diary-task' },
  });
}

export default { name, run, checkAndWrite };
