/**
 * chronicle/store — 群史落盘（events.jsonl 账本 + chronicle.md 叙事）（R7.1）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 目录布局（每群一个目录，天然隔离）
 *
 *   {EXT_DATA}/group-chronicle/
 *     ├── <gid>/
 *     │    ├── events.jsonl      ← 够格事件账本（只追加，长期累积）
 *     │    └── chronicle.md      ← 编年史叙事（LLM 生成，定期整篇重写）
 *     └── diag.log               ← 诊断（提取数/够格数/写入失败）
 *
 *   EXT_DATA 只从 `lib/pack-paths.mjs` 取（铁律 2：路径唯一入口，绝不写死
 *   /sdcard）。测试用 `BNN_CHRONICLE_ROOT` 改道，见下。
 *
 * ── 两条纪律（改代码前先读）──────────────────────────────────────────────
 *
 *   ① **原子写**：一律走 `lib/pure/atomic.mjs`（tmp + rename + EPERM 重试）。
 *      本文件**不自己实现** tmp/rename —— 以前各模块各写一套，有的忘了重试、
 *      有的忘了 mkdir，Android FUSE 上偶发 `EPERM: close` 就丢一次写入。
 *
 *   ② **catch 必须留痕**：本文件所有失败路径都 `diag()` 落一行。
 *      R7 这一路踩过的静默失败（16.4 的三个案例）全是「catch 里 return 默认值」，
 *      让失败伪装成「正常但结果为空」。群史尤其危险：写失败 ⇒ 文件不存在 ⇒
 *      下次读还是空 ⇒ `/群史` 永远说「群史还在长」，没有任何人会发现。
 *
 * ── 幂等（appendEvents 为什么必须按 id 去重）───────────────────────────────
 *
 *   每日任务可能因为宿主重启/补跑而在同一天跑两次（任务中心的实际行为）。
 *   若每次都盲目追加，同一次「周五晚上的开黑」会在群史里出现两遍、三遍，
 *   LLM 叙事会把同一件事讲成「你们常常一起开黑」——次数是编的。
 *   所以：**同 id 不重复追加**，且写入顺序固定（按 startAt,id），
 *   同一批输入重跑两次得到的文件字节完全相同（便于比对、便于排查）。
 *
 * ── 隐私（红线）──────────────────────────────────────────────────────────
 *
 *   · events.jsonl 是**内部账本**，participants 保留 openid（R7.1 §4.1 的数据模型，
 *     后续去重/关系温度要用）。它不为任何对外文本提供 id。
 *   · 任何**会被人看到 / 会喂给 LLM** 的文本（chronicle.md、prompt）在写入前
 *     统一过 `redactOpenids()`（唯一实现在 extract.mjs，纯函数），
 *     32 位 hex 一律替成「某位群友」，并在 diag 里记一笔「剔了几个」——
 *     出现这种情况说明上游没脱敏干净，必须能查出来是谁漏的。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import { appendLogRotating } from '../log-rotate.mjs';
import { dirname, join } from 'node:path';

import { EXT_DATA } from '../pack-paths.mjs';
import {
  readTextSafe,
  readJsonlSafe,
  writeAtomic,
} from '../pure/atomic.mjs';
import { redactOpenids } from './extract.mjs';

/** 账本文件名。 */
export const EVENTS_FILE = 'events.jsonl';
/** 编年史文件名。 */
export const CHRONICLE_FILE = 'chronicle.md';
/** 群史根目录名（相对 EXT_DATA）。 */
export const CHRONICLE_DIR = 'group-chronicle';

/**
 * 群史根目录。
 *
 * 优先级：`BNN_CHRONICLE_ROOT` > `{EXT_DATA}/group-chronicle`
 *
 * 为什么要环境变量：测试必须改道（铁律 6）。为什么不在测试里改 QQBOT_DATA_ROOT：
 * pack-paths 在 **import 时**就固化了 EXT_DATA，而 ESM 静态 import 会被提升，
 * 测试里「先设 env 再 import」不写动态 import 就做不到；漏了就会写生产。
 * 这里每次调用时读 env，测试设一次就对全部调用生效。
 */
export function chronicleRoot() {
  const override = String(process.env.BNN_CHRONICLE_ROOT ?? '').trim();
  return override || join(EXT_DATA, CHRONICLE_DIR);
}

/** 诊断日志路径。 */
export function diagFile() {
  return join(chronicleRoot(), 'diag.log');
}

/**
 * 群 id 做目录名前的清洗。
 *
 * 群 id 是平台下发的 32 位十六进制串，正常情况原样可用；清洗只为兜住
 * 异常输入（空值 / 带 `../` / 带斜杠），**绝不拼出目录穿越**。
 */
export function safeGid(gid) {
  // ★ 2026-11-26 统一命名：项目里 msg-archive / life-stream / group-memory
  //   都用 group_<gid>，这里原来用裸 gid，两套并存会让人以为是两份数据。
  const s = String(gid ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) return 'unknown';
  return s.startsWith('group_') ? s : 'group_' + s;
}

/** 某群的数据目录。 */
export function groupDir(gid) {
  return join(chronicleRoot(), safeGid(gid));
}

/** 某群的事件账本路径。 */
export function eventsFile(gid) {
  return join(groupDir(gid), EVENTS_FILE);
}

/** 某群的编年史路径。 */
export function chronicleFile(gid) {
  return join(groupDir(gid), CHRONICLE_FILE);
}

/** 确保某群目录存在。失败返回 false（不抛）。 */
function ensureGroupDir(gid) {
  try {
    mkdirSync(groupDir(gid), { recursive: true });
    return true;
  } catch (e) {
    diag(`mkdir-fail gid=${safeGid(gid)} ${errText(e)}`);
    return false;
  }
}

/** 错误转一行文本。 */
function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 写一行诊断（失败静默 —— 诊断自身不能拖垮主流程）。
 *
 * 插件 logger 不进 engine.log，关键路径必须自己落盘（与 wake-lottery 同一做法）。
 */
export function diag(line) {
  try {
    const file = diagFile();
    mkdirSync(dirname(file), { recursive: true });
    appendLogRotating(file, `${new Date().toISOString()} [chronicle] ${line}\n`, 'utf8');
  } catch { /* 诊断失败绝不影响主流程 */ }
}

/* ──────────────────────────────────────────────────────────────
 * 事件账本
 * ────────────────────────────────────────────────────────────── */

/** 事件最少要有的形状（缺 id 的记录无法幂等，一律丢弃）。 */
function validEvent(e) {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.id !== 'string' || !e.id.trim()) return false;
  return true;
}

/**
 * 读某群的事件账本。
 *
 * 坏行跳过（`readJsonlSafe` 已实现），缺 id 的行也跳过 —— 它们在 append 时
 * 无法去重，留着只会让同一件事被算两次。跳过数量写 diag，便于排查「谁写进去的」。
 *
 * @param {string} gid
 * @param {object} [opts]
 * @param {boolean} [opts.qualifiedOnly] 只返回 qualified 的事件
 * @returns {Array<object>} 按 startAt 升序；文件不存在/全坏 → []
 */
export function readEvents(gid, opts = {}) {
  const file = eventsFile(gid);
  if (!existsSync(file)) return [];

  let rows;
  try {
    rows = readJsonlSafe(file);
  } catch (e) {
    diag(`read-fail gid=${safeGid(gid)} ${errText(e)}`);
    return [];
  }

  const qualifiedOnly = opts?.qualifiedOnly === true;
  const out = [];
  let dropped = 0;
  for (const r of rows) {
    if (!validEvent(r)) { dropped += 1; continue; }
    if (qualifiedOnly && r.qualified !== true) continue;
    out.push(r);
  }
  if (dropped) diag(`read-drop gid=${safeGid(gid)} rows=${dropped}`);

  out.sort((a, b) => {
    const ta = Number(a.startAt) || 0;
    const tb = Number(b.startAt) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
  return out;
}

/**
 * 追加事件（**幂等**：同 id 不重复追加）。
 *
 * 实现是「读全量 → 按 id 去重合并 → 原子重写整文件」。为什么不用 appendFileSync：
 * ① 去重要先读旧文件；② 整体重写保证文件永远是可解析的完整 JSONL
 * （append 到一半断电/EPERM 会留下半行，之后每次读都少一条，且没人知道）。
 * 代价 O(n)，但账本是「每天几条」的量级，一年也就几百 KB。
 *
 * @param {string} gid
 * @param {Array<object>} events extractEvents 的输出（qualified 的）
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] 只算不写（排查「为什么没入账」用）
 * @returns {{ ok: boolean, added: number, skipped: number, invalid: number, total: number }}
 */
export function appendEvents(gid, events, opts = {}) {
  const out = { ok: false, added: 0, skipped: 0, invalid: 0, total: 0 };
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    // 没有新事件不是错误：账本保持原样，total 回填现有条数供调用方判断
    out.ok = true;
    out.total = readEvents(gid).length;
    return out;
  }

  // ① 清洗入参
  const incoming = [];
  for (const e of list) {
    if (!validEvent(e)) { out.invalid += 1; continue; }
    incoming.push(e);
  }
  if (out.invalid) diag(`append-invalid gid=${safeGid(gid)} count=${out.invalid}`);

  // ② 与旧账本合并（按 id 去重；同一个 id 以**先入账的**为准，不被后来的覆盖）
  const existing = readEvents(gid);
  const byId = new Map();
  for (const e of existing) byId.set(String(e.id), e);

  const merged = existing.slice();
  for (const e of incoming) {
    const id = String(e.id);
    if (byId.has(id)) { out.skipped += 1; continue; }
    byId.set(id, e);
    merged.push(e);
    out.added += 1;
  }

  out.total = merged.length;
  if (!out.added) {
    // 全是重复 ⇒ 幂等命中，文件不需要重写（也不会产生 mtime 抖动）
    out.ok = true;
    return out;
  }

  if (opts?.dryRun === true) {
    out.ok = true;
    return out;
  }

  // ③ 稳定排序后原子重写
  merged.sort((a, b) => {
    const ta = Number(a.startAt) || 0;
    const tb = Number(b.startAt) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id) < String(b.id) ? -1 : 1;
  });

  if (!ensureGroupDir(gid)) return out;

  const text = merged.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const w = writeAtomic(eventsFile(gid), text);
  if (!w.ok) {
    diag(`append-write-fail gid=${safeGid(gid)} added=${out.added} ${String(w.error || '')}`);
    return out;
  }

  out.ok = true;
  return out;
}

/* ──────────────────────────────────────────────────────────────
 * 编年史叙事
 * ────────────────────────────────────────────────────────────── */

/**
 * 写编年史（原子写，整篇覆盖）。
 *
 * 调用方约定（方案 §4.4）：LLM 失败时**不要调本函数**，直接保留旧版 ——
 * 所以这里不做「空内容保护」以外的判断；空串/非字符串一律拒写并留痕，
 * 避免一次异常把群史清空（那是最不可接受的数据丢失）。
 *
 * @param {string} gid
 * @param {string} md  Markdown 正文
 * @param {object} [opts]
 * @param {boolean} [opts.skipRedact] 关掉脱敏（仅测试用；生产绝不传）
 * @returns {{ ok: boolean, redacted: number, bytes: number }}
 */
export function writeChronicle(gid, md, opts = {}) {
  const out = { ok: false, redacted: 0, bytes: 0 };

  if (typeof md !== 'string' || !md.trim()) {
    diag(`chronicle-empty gid=${safeGid(gid)} —— 拒写，保留旧版`);
    return out;
  }

  const { text, redacted } = opts?.skipRedact === true
    ? { text: md, redacted: 0 }
    : redactOpenids(md);
  out.redacted = redacted;
  if (redacted > 0) diag(`chronicle-redact gid=${safeGid(gid)} hex=${redacted}`);

  if (!ensureGroupDir(gid)) return out;

  const body = text.endsWith('\n') ? text : `${text}\n`;
  const w = writeAtomic(chronicleFile(gid), body);
  if (!w.ok) {
    diag(`chronicle-write-fail gid=${safeGid(gid)} ${String(w.error || '')}`);
    return out;
  }

  out.ok = true;
  out.bytes = Buffer.byteLength(body, 'utf8');
  return out;
}

/**
 * 读编年史。
 *
 * @param {string} gid
 * @returns {string} 文件不存在 / 读失败 → ''（不抛）
 */
export function readChronicle(gid) {
  try {
    return readTextSafe(chronicleFile(gid), '');
  } catch (e) {
    diag(`chronicle-read-fail gid=${safeGid(gid)} ${errText(e)}`);
    return '';
  }
}

/* ──────────────────────────────────────────────────────────────
 * 运维
 * ────────────────────────────────────────────────────────────── */

/**
 * 列出已有群史数据的群（按目录名）。
 *
 * 只看带 events.jsonl 的目录 —— 空目录是某次失败的残留，不该出现在列表里。
 *
 * @returns {string[]}
 */
export function listGroups() {
  try {
    const root = chronicleRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(join(root, name, EVENTS_FILE)))
      .sort();
  } catch (e) {
    diag(`list-fail ${errText(e)}`);
    return [];
  }
}

export default {
  EVENTS_FILE,
  CHRONICLE_FILE,
  CHRONICLE_DIR,
  chronicleRoot,
  diagFile,
  safeGid,
  groupDir,
  eventsFile,
  chronicleFile,
  diag,
  readEvents,
  appendEvents,
  writeChronicle,
  readChronicle,
  listGroups,
};
