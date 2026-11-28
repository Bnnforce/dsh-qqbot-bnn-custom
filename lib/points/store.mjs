/**
 * points/store — 积分存档（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 存档布局：
 *   <dataRoot>/<openid>.json
 *
 * 为什么按 openid（不按群）：
 *   实测验证 —— 同一人在不同群的 openid **完全相同**（主人 在 3 个群同 id），
 *   所以 openid 天然是跨群唯一键。这正是"全局积分"的存储基础。
 *
 * 铁律：
 *   · 所有写走原子写（临时文件 + rename）
 *   · 所有读有 try-catch，损坏 → 备份 .corrupt + 重建
 *   · 锁的 key 是 openid（按人串行，不同人并行）
 *   · **不与 shop 的 gid 锁嵌套**（见审查报告的死锁分析）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { shopErr, ERR } from '../pure/errors.mjs';
import { withLock as withKeyLock } from '../pure/lock.mjs';
import { DEFAULT_POINTS_CONFIG } from './config.mjs';

const OPENID_RE = /^[0-9A-Za-z_-]{8,64}$/;

function assertOpenid(openid) {
  const o = String(openid ?? '');
  if (!OPENID_RE.test(o)) {
    throw shopErr(ERR.INVALID_ARG, `openid 非法: ${o.slice(0, 12)}`, { openid: o.slice(0, 12) });
  }
  return o;
}

function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function readJsonSafe(file) {
  if (!existsSync(file)) return null;
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    return JSON.parse(raw);
  } catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return null;
  }
}

/** 新建一个空档案。 */
export function createEmptyPoints(openid, name, nowIso) {
  return {
    version: DEFAULT_POINTS_CONFIG.stateVersion,
    openid,
    name: String(name ?? '').slice(0, 40),
    balance: 0,

    checkin: { lastDate: '', totalDays: 0 },
    fortune: { lastDateKey: '', lastScore: 0 },
    dailyPlay: { date: '', used: 0, byGame: {} },

    stats: {
      totalEarned: 0,
      totalSpent: 0,
      firstSeenAt: nowIso,
      lastActiveAt: nowIso,
    },

    ledger: [],
  };
}

/**
 * 创建积分存储。
 *
 * @param {{dataRoot:string, cfg?:object, logger?:object}} opts
 */
export function createPointsStore(opts = {}) {
  const dataRoot = String(opts.dataRoot ?? '').trim();
  if (!dataRoot) throw shopErr(ERR.CONFIG_INVALID, 'createPointsStore 需要 dataRoot');
  const cfg = { ...DEFAULT_POINTS_CONFIG, ...(opts.cfg || {}) };
  const logger = opts.logger;

  const fileOf = (openid) => join(dataRoot, `${assertOpenid(openid)}.json`);

  let ensured = false;
  const ensureRoot = () => {
    if (ensured) return;
    try { mkdirSync(dataRoot, { recursive: true }); ensured = true; } catch { /* retry next */ }
  };

  return {
    dataRoot,
    cfg,

    /** 读档案（不存在返回 null）。 */
    read(openid) {
      ensureRoot();
      return readJsonSafe(fileOf(openid));
    },

    /** 写档案（原子）。 */
    write(openid, data) {
      ensureRoot();
      try {
        writeTextAtomic(fileOf(openid), `${JSON.stringify(data, null, 2)}\n`);
      } catch (e) {
        throw shopErr(ERR.STORE_WRITE_FAILED, `写积分失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    /** 读或建（不持锁，供只读场景）。 */
    readOrCreate(openid, name, nowIso) {
      const d = this.read(openid);
      if (d) return d;
      return createEmptyPoints(assertOpenid(openid), name, nowIso);
    },

    /**
     * 事务：读-改-写全程持锁。
     *
     * @param {string} openid
     * @param {(data:object) => (object|void|Promise<object|void>)} mutator
     * @param {{name?:string, nowIso?:string}} init 档案不存在时用于创建
     */
    async update(openid, mutator, init = {}) {
      const oid = assertOpenid(openid);
      return withKeyLock(oid, async () => {
        const nowIso = init.nowIso || new Date().toISOString();
        let d = readJsonSafe(fileOf(oid));
        if (!d) d = createEmptyPoints(oid, init.name, nowIso);
        const next = await mutator(d);
        const out = next && typeof next === 'object' ? next : d;
        writeTextAtomic(fileOf(oid), `${JSON.stringify(out, null, 2)}\n`);
        return out;
      });
    },

    /** 只读事务（持锁，保证读到一致快照）。 */
    async readLocked(openid, fn) {
      const oid = assertOpenid(openid);
      return withKeyLock(oid, async () => fn(readJsonSafe(fileOf(oid))));
    },

    /**
     * 追加 ledger（自动裁剪到 maxLedger）。
     * @returns {object} 传入的 data（已修改）
     */
    pushLedger(data, entry) {
      const max = Number(cfg.maxLedger) > 0 ? Number(cfg.maxLedger) : 100;
      data.ledger = Array.isArray(data.ledger) ? data.ledger : [];
      data.ledger.push(entry);
      if (data.ledger.length > max) data.ledger = data.ledger.slice(-max);
      return data;
    },

    /** 列出所有有档案的 openid（排行榜/运维用）。 */
    listOpenids() {
      ensureRoot();
      try {
        return readdirSync(dataRoot)
          .filter((f) => f.endsWith('.json') && !f.includes('.corrupt-') && !f.includes('.tmp-'))
          .map((f) => f.replace(/\.json$/, ''))
          .filter((x) => OPENID_RE.test(x));
      } catch { return []; }
    },

    /** 删除某人档案（「清空积分」用）。 */
    remove(openid) {
      const f = fileOf(openid);
      try {
        if (!existsSync(f)) return false;
        renameSync(f, `${f}.deleted-${Date.now()}`);
        return true;
      } catch { return false; }
    },

    /** 从 ledger 重建余额（存档损坏时的保险）。 */
    rebuildFromLedger(data) {
      if (!Array.isArray(data?.ledger)) return null;
      let bal = 0;
      let earned = 0;
      let spent = 0;
      for (const e of data.ledger) {
        const d = Number(e?.delta) || 0;
        bal += d;
        if (d > 0) earned += d;
        else spent += -d;
      }
      return { balance: bal, totalEarned: earned, totalSpent: spent };
    },

    _assertOpenid: assertOpenid,
  };
}
