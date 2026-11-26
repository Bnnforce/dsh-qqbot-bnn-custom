/**
 * life-stream/store — 生活日志落盘（R7.2 · 只写本地，绝不推送）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 目录（{EXT_DATA} = 扩展共享数据根，走 pack-paths.mjs，绝不硬编码）
 *
 *   {EXT_DATA}/life-stream/<gid>/today.jsonl        今天
 *   {EXT_DATA}/life-stream/<gid>/archive/<date>.jsonl   历史（跨天搬过去）
 *   {EXT_DATA}/life-stream/diag.log                 诊断
 *
 * ── 四条纪律 ───────────────────────────────────────────────────────────────
 *   ① **绝不推送**：本模块只碰文件系统，没有任何 outbound / env 依赖。
 *      生活流推群 = 刷屏噪音（R7.2 §「明确不做」）。
 *   ② **原子写**：一律走 `lib/pure/atomic.mjs`，不自己实现 tmp+rename。
 *      JSONL 用 appendJsonlAtomic（它整体重写，比 appendFileSync 安全）。
 *   ③ **catch 必留痕**：读失败回落默认值属于"静默失败"高发区（§16.4），
 *      所以每条失败路径都写 diag.log，人能看到「为什么今天没数据」。
 *   ④ **文件名叫 today.jsonl，但跨天要搬**：文件名固定才好找，
 *      跨天由 rolloverIfNeeded() 把内容搬进 archive/<date>.jsonl 并清空。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { EXT_DATA } from '../pack-paths.mjs';
import { appendJsonlAtomic, readJsonlSafe } from '../pure/atomic.mjs';

/** 今天这个文件名（固定，方便人肉查看）。 */
const TODAY_FILE = 'today.jsonl';

/** 保留天数（R7.2 §6.1：日志无限增长，按日归档保留 30 天）。 */
const KEEP_DAYS = 30;

/* ──────────────────────────────────────────────────────────────
 * 一、路径
 * ────────────────────────────────────────────────────────────── */

/**
 * 生活流根目录。
 *
 * 优先级：BNN_LIFESTREAM_ROOT（测试改道用）> {EXT_DATA}/life-stream
 *
 * ⚠️ 每次调用都重新读 env，不在模块加载时冻住 ——
 *    测试常常在 import 之后才设改道变量，冻住就会写进生产（开发规则 §6.1）。
 *
 * @returns {string}
 */
export function rootDir() {
  const override = String(process.env.BNN_LIFESTREAM_ROOT ?? '').trim();
  return override || join(EXT_DATA, 'life-stream');
}

/**
 * 群号 → 目录名。
 *
 * 为什么要分两种情况（2026-11-26）：
 *   ① **数字群号 → 原样保留**。`{EXT_DATA}/life-stream/<gid>/` 是方案里写定的布局，
 *      且本包既有模块（msg-archive 的 `group_<gid>`）都是可读目录。
 *      目录名可读，主人一眼能看出"哪个群今天没数据"，排查成本差一个量级。
 *      ⚠️ 别的模块可能自己拼这个路径，所以**这里不能改成哈希**——
 *      改了就会和兄弟模块算出两个目录，数据静默分裂。
 *   ② **32 位 hex（openid 形状）→ 哈希**。红线 2「不写真实 id」，
 *      这种形状的 id 原样落进目录名就等于把隐私写进文件列表。
 *
 * 另外一律剥掉路径分隔符等危险字符（防目录穿越）。
 *
 * @param {string} gid
 * @returns {string}
 */
export function safeGid(gid) {
  const raw = String(gid ?? '').trim();
  if (!raw) return 'unknown';

  // ① openid 形状 → 哈希（不可逆，且跨群仍互不相同）
  if (/^[0-9a-fA-F]{32,}$/.test(raw)) {
    try {
      return `id-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
    } catch { /* 拿不到 crypto 时落到下面的清洗分支 */ }
  }

  // ② 普通群号：只留安全字符
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'unknown';
}

/** 某群的目录。 */
export function groupDir(gid) {
  return join(rootDir(), safeGid(gid));
}

/** 某群今天的日志文件。 */
export function todayFile(gid) {
  return join(groupDir(gid), TODAY_FILE);
}

/** 某群的归档目录。 */
export function archiveDir(gid) {
  return join(groupDir(gid), 'archive');
}

/** 某群某天的归档文件。 */
export function archiveFile(gid, date) {
  return join(archiveDir(gid), `${safeDate(date)}.jsonl`);
}

/** 诊断日志文件。 */
export function diagFile() {
  return join(rootDir(), 'diag.log');
}

/** 日期做文件名前的清洗（只留数字和连字符）。 */
function safeDate(date) {
  const s = String(date ?? '').replace(/[^0-9-]/g, '');
  return s || 'unknown';
}

/** 本地日期键 YYYY-MM-DD（按机器时区，生活流跟"她所在的地方"走）。 */
export function dateKey(now) {
  const d = now instanceof Date && Number.isFinite(now.getTime())
    ? now
    : new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const safe = Number.isFinite(d.getTime()) ? d : new Date();
  return `${safe.getFullYear()}-${String(safe.getMonth() + 1).padStart(2, '0')}-${String(safe.getDate()).padStart(2, '0')}`;
}

/* ──────────────────────────────────────────────────────────────
 * 二、诊断留痕
 * ────────────────────────────────────────────────────────────── */

/**
 * 写一行诊断。
 *
 * 为什么不 `console.log`：插件的 logger 不进 engine.log，
 * 关键路径（读失败、写失败、跨天搬家失败）必须自己落盘才查得到。
 *
 * @param {string} line
 */
export function diag(line) {
  try {
    const file = diagFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' });
  } catch { /* 诊断失败绝不影响主流程 */ }
}

/* ──────────────────────────────────────────────────────────────
 * 三、写
 * ────────────────────────────────────────────────────────────── */

/**
 * 追加一条生活日志。
 *
 * @param {string} gid 群 id
 * @param {{at?:number, hour?:number, activity?:string, detail?:string,
 *          mood?:{mood?:number,energy?:number}, ref?:object,
 *          reason?:string, seed?:string}} entry
 * @returns {{ok:boolean, entry?:object, error?:string}}
 */
export function appendLifeLog(gid, entry) {
  const row = normalizeEntry(entry);
  if (!row) {
    diag(`[写] 拒绝空日志 gid=${safeGid(gid)}`);
    return { ok: false, error: 'entry 非法' };
  }

  const file = todayFile(gid);
  try {
    const r = appendJsonlAtomic(file, row);
    if (!r.ok) {
      diag(`[写] 失败 gid=${safeGid(gid)} err=${r.error || '未知'}`);
      return { ok: false, error: r.error };
    }
    return { ok: true, entry: row };
  } catch (e) {
    // atomic 内部已兜住大部分异常，这里兜的是它没料到的（如 mkdir 抛）
    diag(`[写] 异常 gid=${safeGid(gid)} err=${e?.message || e}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * 把一条日志清洗成固定形状。
 *
 * 为什么逐字段校验而不是 `{...entry}`：
 * 生活日志会被心跳引用进提示词，多余字段（尤其是 id 类）会顺着漏进正文。
 * 白名单是唯一稳妥的做法。
 *
 * @param {object} entry
 * @returns {object|null}
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const at = Number(entry.at);
  const safeAt = Number.isFinite(at) && at > 0 ? Math.trunc(at) : Date.now();
  const d = new Date(safeAt);
  const hour = Number.isFinite(Number(entry.hour)) ? Math.trunc(Number(entry.hour)) : d.getHours();

  const activity = String(entry.activity ?? '').trim();
  if (!activity) return null;

  const detail = scrubText(entry.detail);
  if (!detail) {
    // detail 为空 = 日志没有内容可被引用，直接拒写（不写"空壳"充数）
    return null;
  }

  const row = {
    at: safeAt,
    hour: Math.min(23, Math.max(0, hour)),
    activity,
    detail,
    mood: {
      mood: clamp01(entry?.mood?.mood),
      energy: clamp01(entry?.mood?.energy),
    },
  };

  if (typeof entry.reason === 'string' && entry.reason) row.reason = entry.reason;

  // ref 只保留 kind/id 两个字符串字段，其余一律丢弃
  const ref = entry.ref && typeof entry.ref === 'object' ? entry.ref : null;
  if (ref) {
    const kind = scrubText(ref.kind);
    const id = scrubText(ref.id);
    if (kind || id) row.ref = { kind, id };
  }

  return row;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 抹掉 32 位以上 hex（openid 形状），兜底隐私。 */
function scrubText(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[0-9a-fA-F]{32,}/g, '').trim();
}

/* ──────────────────────────────────────────────────────────────
 * 四、读
 * ────────────────────────────────────────────────────────────── */

/**
 * 读今天的日志（坏行跳过，不存在返回 []，**绝不抛**）。
 *
 * @param {string} gid
 * @returns {object[]}
 */
export function readTodayLog(gid) {
  const file = todayFile(gid);
  try {
    const rows = readJsonlSafe(file);
    return rows.filter((r) => r && typeof r === 'object' && typeof r.activity === 'string');
  } catch (e) {
    diag(`[读] 失败 gid=${safeGid(gid)} err=${e?.message || e}`);
    return [];
  }
}

/**
 * 最近 N 小时做过的活动类型（旧→新）。
 *
 * `recentKinds` 是 pick.mjs 防复读机的唯一输入，所以这里的时间过滤必须准：
 * **只看 at >= now - hours**，不看"最后 N 条"——
 * 否则深夜连跑几次之后，窗口里全是睡觉，白天也会被误判成复读。
 *
 * @param {string} gid
 * @param {number} [hours] 默认 3（R7.2 §6.1：同类活动 3 小时内不重复）
 * @param {number} [now] 时间基准（测试用）
 * @returns {string[]}
 */
export function recentKinds(gid, hours = 3, now) {
  const h = Number(hours);
  const span = Number.isFinite(h) && h > 0 ? h : 3;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const since = nowMs - span * 3600000;

  const rows = readTodayLog(gid);
  const out = [];
  for (const r of rows) {
    const at = Number(r?.at);
    if (!Number.isFinite(at)) continue;
    if (at < since) continue;
    const kind = String(r.activity || '').trim();
    if (kind) out.push(kind);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────
 * 五、跨天归档
 * ────────────────────────────────────────────────────────────── */

/**
 * 跨天处理：today.jsonl 的内容搬进 archive/<它自己的日期>.jsonl，然后清空。
 *
 * 日期取**文件里第一条记录的 at**，而不是"今天" ——
 * 文件名固定为 today.jsonl，只有记录自己能证明它是哪天的。
 *
 * 幂等：搬完就清空，再调一次无事可做（返回 moved:0）。
 *
 * @param {string} gid
 * @param {number} [now]
 * @returns {{moved:number, date:string, ok:boolean, error?:string}}
 */
export function rolloverIfNeeded(gid, now) {
  const file = todayFile(gid);
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();

  if (!existsSync(file)) return { moved: 0, date: '', ok: true };

  let rows;
  try {
    rows = readJsonlSafe(file);
  } catch (e) {
    diag(`[跨天] 读失败 gid=${safeGid(gid)} err=${e?.message || e}`);
    return { moved: 0, date: '', ok: false, error: String(e?.message || e) };
  }
  if (!rows.length) {
    // 空文件（可能是上次搬到一半）→ 直接删，别留着占位
    try { unlinkSync(file); } catch { /* ignore */ }
    return { moved: 0, date: '', ok: true };
  }

  const firstAt = Number(rows[0]?.at);
  const fileDate = dateKey(Number.isFinite(firstAt) ? firstAt : nowMs);
  const today = dateKey(nowMs);

  // 文件里还是今天的东西 → 不用搬
  if (fileDate === today) return { moved: 0, date: fileDate, ok: true };

  try {
    mkdirSync(archiveDir(gid), { recursive: true });
    const dst = archiveFile(gid, fileDate);

    // 已有归档 → 追加在它后面（同一天可能跨两次进程），否则直接写
    const prev = existsSync(dst) ? readFileSync(dst, 'utf8') : '';
    const appended = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(dst, `${prev}${appended}`, 'utf8');

    // ★ 顺序很重要：先确认归档写成功，再删 today。
    //   反过来一旦中间失败，这一天的数据就永久丢了。
    unlinkSync(file);
    return { moved: rows.length, date: fileDate, ok: true };
  } catch (e) {
    diag(`[跨天] 失败 gid=${safeGid(gid)} date=${fileDate} err=${e?.message || e}`);
    return { moved: 0, date: fileDate, ok: false, error: String(e?.message || e) };
  }
}

/**
 * 清掉超过 KEEP_DAYS 的归档（R7.2 §6.1）。
 *
 * 单个文件删失败不影响其他（Android FUSE 下删文件偶发失败是正常的）。
 *
 * @returns {{removed:number, scanned:number}}
 */
export function pruneArchive(gid, keepDays = KEEP_DAYS) {
  const out = { removed: 0, scanned: 0 };
  const days = Number(keepDays) > 0 ? Number(keepDays) : KEEP_DAYS;
  const cutoff = Date.now() - days * 86400000;

  let names;
  try {
    if (!existsSync(archiveDir(gid))) return out;
    names = readdirSync(archiveDir(gid));
  } catch (e) {
    diag(`[清理] 读目录失败 gid=${safeGid(gid)} err=${e?.message || e}`);
    return out;
  }

  let failed = 0;
  let lastErr = '';
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    out.scanned += 1;
    const dateStr = name.replace(/\.jsonl$/, '');
    const t = Date.parse(`${dateStr}T00:00:00`);
    if (!Number.isFinite(t)) continue;
    if (t >= cutoff) continue;
    try {
      unlinkSync(join(archiveDir(gid), name));
      out.removed += 1;
    } catch (e) {
      // 单个失败不影响其他，但**不能完全静默**：
      // 循环里不逐条写盘（删 30 天会刷爆日志），计数后汇总写一行。
      failed += 1;
      lastErr = String(e?.message || e);
    }
  }
  if (failed > 0) {
    diag(`[清理] ${failed} 个归档删除失败 gid=${safeGid(gid)} 最后一个错误=${lastErr}`);
  }
  return out;
}

export default {
  rootDir,
  safeGid,
  groupDir,
  todayFile,
  archiveDir,
  archiveFile,
  diagFile,
  dateKey,
  diag,
  appendLifeLog,
  readTodayLog,
  recentKinds,
  rolloverIfNeeded,
  pruneArchive,
};
