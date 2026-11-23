/**
 * atomic.mjs — 状态文件原子写（扩展包侧唯一实现）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个文件（工业化开发手册 §7.1 / §7.2）
 *
 * ① 并发损坏：qqbot 里同一条消息可能被 hooks + inbound + outbound 多处读写，
 *    直接 `writeFileSync(final, ...)` 在写一半时被读，读到的就是半截 JSON，
 *    之后所有解析都失败，功能静默挂掉。
 *    → 做法：写 `<file>.tmp` 再 `rename`。rename 在同一文件系统内是原子的，
 *      读的一方要么看到旧的完整内容，要么看到新的完整内容。
 *
 * ② Android FUSE 的 EPERM：`writeFileSync` 偶发抛
 *    `EPERM: operation not permitted, close`。
 *    这不是没权限，是 FUSE 写入后被系统抢占导致的**瞬时**错误，
 *    重试一两次就好。以前没重试 → 偶尔丢一次状态写入，很难复现。
 *    → 做法：写临时文件时带重试。
 *
 * ③ 统一入口：以前各模块各写一套 tmp+rename，有的忘了 retry，有的忘了 mkdir，
 *    有的 rename 失败没兜底。现在只从这里出。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 不适用范围：写图片/音频/SILK 等**产物缓存**不需要原子写（写坏了下次重新生成），
 *    用普通 writeFileSync 即可，别为了"统一"给大文件加 rename 开销。
 */
import {
  writeFileSync,
  renameSync,
  mkdirSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** Android FUSE 瞬时 EPERM 的重试次数。 */
const WRITE_RETRIES = 6;
/** 每次重试前的等待（毫秒）。 */
const RETRY_DELAY_MS = 12;

/** 同步睡一会儿（Node 没有 sync sleep，用忙等；这里量级只有十几毫秒）。 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) { /* busy wait */ }
}

/**
 * 确保父目录存在（失败静默 —— 真正的写操作会再报错）。
 *
 * @param {string} file
 */
function ensureParent(file) {
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch { /* ignore */ }
}

/**
 * 原子写文本。写临时文件（带 EPERM 重试）→ rename 到目标。
 *
 * @param {string} file 目标路径
 * @param {string|Buffer} data
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeAtomic(file, data) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  ensureParent(file);

  // ① 写临时文件（EPERM 重试）
  let lastErr = null;
  for (let i = 0; i < WRITE_RETRIES; i += 1) {
    try {
      writeFileSync(tmp, data, typeof data === 'string' ? 'utf8' : undefined);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      sleepSync(RETRY_DELAY_MS);
    }
  }
  if (lastErr) {
    try { unlinkSync(tmp); } catch { /* 可能没建出来 */ }
    return { ok: false, error: String(lastErr?.message || lastErr) };
  }

  // ② rename 到目标（同样可能瞬时 EPERM）
  for (let i = 0; i < WRITE_RETRIES; i += 1) {
    try {
      renameSync(tmp, file);
      return { ok: true };
    } catch (e) {
      lastErr = e;
      sleepSync(RETRY_DELAY_MS);
    }
  }
  try { unlinkSync(tmp); } catch { /* ignore */ }
  return { ok: false, error: String(lastErr?.message || lastErr) };
}

/**
 * 原子写 JSON（自动 pretty）。
 *
 * @param {string} file
 * @param {unknown} value
 * @param {number} [indent]
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeJsonAtomic(file, value, indent = 2) {
  let text;
  try {
    text = JSON.stringify(value, null, indent);
  } catch (e) {
    return { ok: false, error: `JSON 序列化失败: ${e?.message || e}` };
  }
  return writeAtomic(file, text);
}

/**
 * 安全读 JSON：文件不存在/内容坏/没权限 → 返回 fallback，绝不抛。
 *
 * @template T
 * @param {string} file
 * @param {T} [fallback]
 * @returns {T}
 */
export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 安全读文本：失败返回 fallback。
 *
 * @param {string} file
 * @param {string} [fallback]
 * @returns {string}
 */
export function readTextSafe(file, fallback = '') {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * 读-改-写 一个 JSON 文件（原子）。mutator 抛错则不写。
 *
 * @template T
 * @param {string} file
 * @param {(prev: T) => T} mutator
 * @param {T} fallback 文件不存在时传进去的初值
 * @returns {{ ok: boolean, value?: T, error?: string }}
 */
export function mutateJsonAtomic(file, mutator, fallback) {
  const prev = readJsonSafe(file, fallback);
  let next;
  try {
    next = mutator(prev);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  const w = writeJsonAtomic(file, next);
  return w.ok ? { ok: true, value: next } : { ok: false, error: w.error };
}

/**
 * 原子追加一行（JSONL）。整体重写文件，所以比 appendFileSync 安全，
 * 但代价是 O(n) —— 只适合行数不多的诊断日志。
 *
 * @param {string} file
 * @param {unknown} row
 * @returns {{ ok: boolean, error?: string }}
 */
export function appendJsonlAtomic(file, row) {
  const prev = readJsonlSafe(file);
  prev.push(row);
  return writeAtomic(file, prev.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * 安全读 JSONL：坏行跳过。
 *
 * @param {string} file
 * @returns {any[]}
 */
export function readJsonlSafe(file) {
  const text = readTextSafe(file, '');
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 文件是否存在（不抛）。
 *
 * @param {string} file
 * @returns {boolean}
 */
export function fileExists(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

export default {
  writeAtomic,
  writeJsonAtomic,
  readJsonSafe,
  readTextSafe,
  mutateJsonAtomic,
  appendJsonlAtomic,
  readJsonlSafe,
  fileExists,
};
