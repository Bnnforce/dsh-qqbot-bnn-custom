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
      content = await generateDiary({ ctx: env?.ctx ?? env, persona, events, meta: { date, timeoutMs: 20_000 } });
    } catch { content = null; }
    if (!content || !content.trim()) {
      content = placeholderDiary(persona);
    }

    // 落盘（原子写）
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
