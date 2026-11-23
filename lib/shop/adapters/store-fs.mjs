/**
 * shop/adapters/store-fs — 文件系统存储适配器（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 契约（实现 ShopStore 接口，将来可换 SQLite/Redis）：
 *   readShop(gid) / writeShop(gid, s)
 *   readCustomer(gid, openid) / writeCustomer(gid, openid, c)
 *   readGlobal(openid) / writeGlobal(openid, s)
 *   appendHistory(gid, ev) / readHistory(gid, opts)
 *   withLock(gid, fn)
 *
 * 目录布局（dataRoot 由调用方注入，不写死）：
 *   <dataRoot>/<群id>.json
 *   <dataRoot>/<群id>.history.jsonl
 *   <dataRoot>/archive/<群id>-YYYYMM.jsonl
 *   <dataRoot>/customers/<群id>/<openid>.json
 *   <dataRoot>/customers/global/<openid>.json
 *
 * 铁律：
 *   · 所有写走原子写（临时文件 + rename）
 *   · 所有读有 try-catch，失败返回 null 而不是抛
 *   · 损坏的存档备份成 .corrupt，再重建
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync,
  readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { shopErr, ERR } from '../errors.mjs';
import { withLock as withKeyLock } from '../lock.mjs';
import { monthKeyOf } from '../time.mjs';

/** 群 id / openid 的合法形状（防路径穿越）。 */
const GID_RE = /^[0-9A-Fa-f]{32}$/;
const OPENID_RE = /^[0-9A-Za-z_-]{8,64}$/;

function assertGid(gid) {
  const g = String(gid ?? '');
  if (!GID_RE.test(g)) throw shopErr(ERR.INVALID_ARG, `群 id 非法: ${g.slice(0, 12)}`, { gid: g.slice(0, 12) });
  return g;
}
function assertOpenid(openid) {
  const o = String(openid ?? '');
  if (!OPENID_RE.test(o)) throw shopErr(ERR.INVALID_ARG, `openid 非法: ${o.slice(0, 12)}`, { openid: o.slice(0, 12) });
  return o;
}

/** 原子写文本。 */
function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/** 安全读 JSON：不存在返回 null；损坏则备份并返回 null。 */
function readJsonSafe(file) {
  if (!existsSync(file)) return null;
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    return JSON.parse(raw);
  } catch {
    // 损坏 → 备份，下一次写会重建
    try {
      const bak = `${file}.corrupt-${Date.now()}`;
      renameSync(file, bak);
    } catch { /* 备份失败也不阻断 */ }
    return null;
  }
}

function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 创建文件存储适配器。
 *
 * @param {{dataRoot: string, timezone?: string, logger?: object}} opts
 */
export function createFsStore(opts = {}) {
  const dataRoot = String(opts.dataRoot ?? '').trim();
  if (!dataRoot) throw shopErr(ERR.CONFIG_INVALID, 'createFsStore 需要 dataRoot');
  const timezone = opts.timezone || 'Asia/Shanghai';
  const logger = opts.logger;

  const shopFile = (gid) => join(dataRoot, `${assertGid(gid)}.json`);
  const historyFile = (gid) => join(dataRoot, `${assertGid(gid)}.history.jsonl`);
  const archiveDir = () => join(dataRoot, 'archive');
  const customerFile = (gid, openid) => join(dataRoot, 'customers', assertGid(gid), `${assertOpenid(openid)}.json`);
  const globalFile = (openid) => join(dataRoot, 'customers', 'global', `${assertOpenid(openid)}.json`);

  // mkdir 只做一次（懒执行，失败不阻断）
  let ensured = false;
  const ensureRoot = () => {
    if (ensured) return;
    try { mkdirSync(dataRoot, { recursive: true }); ensured = true; } catch { /* 下次再试 */ }
  };

  return {
    // ── 群存档 ──
    readShop(gid) {
      ensureRoot();
      const v = readJsonSafe(shopFile(gid));
      if (v === null) return null;
      return v;
    },
    writeShop(gid, state) {
      ensureRoot();
      try {
        writeJsonAtomic(shopFile(gid), state);
      } catch (e) {
        throw shopErr(ERR.STORE_WRITE_FAILED, `写存档失败: ${e instanceof Error ? e.message : String(e)}`, { gid: assertGid(gid) });
      }
    },

    // ── 顾客 ──
    readCustomer(gid, openid) {
      ensureRoot();
      return readJsonSafe(customerFile(gid, openid));
    },
    writeCustomer(gid, openid, c) {
      ensureRoot();
      try {
        writeJsonAtomic(customerFile(gid, openid), c);
      } catch (e) {
        throw shopErr(ERR.STORE_WRITE_FAILED, `写顾客失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    // ── 全局标记（只有数字）──
    readGlobal(openid) {
      ensureRoot();
      return readJsonSafe(globalFile(openid));
    },
    writeGlobal(openid, s) {
      ensureRoot();
      try {
        writeJsonAtomic(globalFile(openid), s);
      } catch (e) {
        throw shopErr(ERR.STORE_WRITE_FAILED, `写全局标记失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    // ── 流水 ──
    appendHistory(gid, ev) {
      ensureRoot();
      const line = `${JSON.stringify(ev)}\n`;
      try {
        mkdirSync(dataRoot, { recursive: true });
        appendFileSync(historyFile(gid), line, 'utf8');
      } catch (e) {
        // 流水是辅助数据：写失败只记 warn，不阻断主流程
        logger?.warn?.(`[shop] 流水写入失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    /**
     * 读流水。
     * @param {string} gid
     * @param {{limit?: number, month?: string}} opts limit 取最近 N 条
     */
    readHistory(gid, opts = {}) {
      ensureRoot();
      const f = historyFile(gid);
      if (!existsSync(f)) return [];
      let raw = '';
      try { raw = readFileSync(f, 'utf8'); } catch { return []; }
      const out = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
      }
      const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
      return limit > 0 ? out.slice(-limit) : out;
    },

    /**
     * 按月归档：把当月以前的流水移到 archive/。
     *
     * @param {string} gid
     * @param {number} nowMs
     * @returns {{moved:number, archivedTo:string|null}}
     */
    archiveOldHistory(gid, nowMs = Date.now()) {
      ensureRoot();
      const f = historyFile(gid);
      if (!existsSync(f)) return { moved: 0, archivedTo: null };
      const curMonth = monthKeyOf(nowMs, timezone);
      let raw = '';
      try { raw = readFileSync(f, 'utf8'); } catch { return { moved: 0, archivedTo: null }; }

      const keep = [];
      const byMonth = new Map();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const mk = typeof ev?.ts === 'string' ? ev.ts.slice(0, 7) : curMonth;
        if (mk >= curMonth) { keep.push(line); continue; }
        if (!byMonth.has(mk)) byMonth.set(mk, []);
        byMonth.get(mk).push(line);
      }
      if (byMonth.size === 0) return { moved: 0, archivedTo: null };

      let moved = 0;
      let lastFile = null;
      try {
        mkdirSync(archiveDir(), { recursive: true });
        for (const [mk, lines] of byMonth) {
          const af = join(archiveDir(), `${assertGid(gid)}-${mk}.jsonl`);
          appendFileSync(af, lines.join('\n') + '\n', 'utf8');
          moved += lines.length;
          lastFile = af;
        }
        writeTextAtomic(f, keep.length ? keep.join('\n') + '\n' : '');
      } catch (e) {
        logger?.warn?.(`[shop] 归档失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
        return { moved: 0, archivedTo: null };
      }
      return { moved, archivedTo: lastFile };
    },

    /** 列出所有有存档的群 id（诊断/运维用）。 */
    listGroups() {
      ensureRoot();
      try {
        return readdirSync(dataRoot)
          .filter((f) => GID_RE.test(f.replace(/\.json$/, '')) && (f.endsWith('.json') && !f.endsWith('.history.jsonl')))
          .map((f) => f.replace(/\.json$/, ''));
      } catch { return []; }
    },

    /** 删除某人的个人档案（「忘记我」功能）。 */
    forgetCustomer(gid, openid) {
      const ok = [];
      for (const f of [customerFile(gid, openid), globalFile(openid)]) {
        try { if (existsSync(f)) { unlinkSync(f); ok.push(f); } } catch { /* ignore */ }
      }
      return ok.length;
    },

    /** 锁（委托给 keyed 锁）。 */
    withLock(gid, fn, lockOpts) {
      return withKeyLock(assertGid(gid), fn, lockOpts);
    },

    /** 暴露根目录（诊断用）。 */
    dataRoot,
  };
}