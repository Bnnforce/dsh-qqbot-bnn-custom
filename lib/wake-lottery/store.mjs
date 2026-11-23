/**
 * wake-lottery/store — 状态读写（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条纪律（改之前先读）
 *
 *   ① **原子写**：先写临时文件再 rename。绝不出现半截 JSON。
 *   ② **损坏自愈**：读到坏文件 → 当成空状态 + 写诊断，**绝不抛**。
 *   ③ **隐私**：用户的 openid 一律先过 hashOpenid()，**落盘的永远不是明文**。
 *
 * 目录布局（{EXT_DATA}/wake-lottery/）：
 *   <gid>.json                 每群状态
 *   _global.json               全局小时计数（跨群护栏）
 *   atlas/<gid>/<hash>.json    图鉴（按用户哈希）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
  readdirSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { EXT_DATA } from '../pack-paths.mjs';
import { DEFAULT_CONFIG } from './config.mjs';

/* ──────────────────────────────────────────────────────────────
 * 一、路径
 * ────────────────────────────────────────────────────────────── */

/**
 * 状态根目录。
 *
 * 优先级：BNN_WAKELOTTERY_ROOT > {EXT_DATA}/wake-lottery
 * （测试必须设前者，避免污染生产）
 */
export function rootDir() {
  const override = String(process.env.BNN_WAKELOTTERY_ROOT ?? '').trim();
  return override || join(EXT_DATA, 'wake-lottery');
}

/** 某群的状态文件路径。 */
export function stateFile(gid) {
  return join(rootDir(), `${safeGid(gid)}.json`);
}

/** 全局计数文件路径。 */
export function globalFile() {
  return join(rootDir(), '_global.json');
}

/** 图鉴目录。 */
export function atlasDir(gid) {
  return join(rootDir(), 'atlas', safeGid(gid));
}

/** 图鉴文件路径（按用户哈希）。 */
export function atlasFile(gid, hash) {
  return join(atlasDir(gid), `${String(hash || 'nohash').replace(/[^A-Za-z0-9]/g, '')}.json`);
}

/** 群号做文件名前的清洗（防目录穿越）。 */
function safeGid(gid) {
  const s = String(gid ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return s || 'unknown';
}

/** 诊断日志路径。 */
export function diagFile() {
  return join(rootDir(), 'diag.log');
}

/* ──────────────────────────────────────────────────────────────
 * 二、原子写 / 安全读
 * ────────────────────────────────────────────────────────────── */

/**
 * 原子写文本：临时文件 → rename。
 *
 * @returns {boolean} 成功 true，失败 false（不抛）
 */
export function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

/** 原子写 JSON。 */
export function writeJsonAtomic(file, value) {
  try {
    return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    return false;
  }
}

/** 读 JSON；不存在/损坏 → null（不抛）。 */
export function readJsonSafe(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 写一行诊断（失败静默）。
 *
 * 插件 logger 不进 engine.log，所以关键路径必须自己落盘。
 */
export function diag(line) {
  try {
    const file = diagFile();
    mkdirSync(dirname(file), { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(file, `[${ts}] ${line}\n`, { flag: 'a' });
  } catch { /* 诊断失败绝不影响主流程 */ }
}

/* ──────────────────────────────────────────────────────────────
 * 三、隐私：openid 哈希
 * ────────────────────────────────────────────────────────────── */

/**
 * 把 openid 变成不可逆短哈希。
 *
 * **所有落盘前必须过这一道**（开源上架隐私要求）。
 *
 * @param {string} openid
 * @param {string} [salt]
 * @returns {string} 16 位十六进制；空输入返回 ''
 */
export function hashOpenid(openid, salt) {
  const raw = String(openid ?? '').trim();
  if (!raw) return '';
  const s = String(salt ?? DEFAULT_CONFIG.salt);
  try {
    return createHash('sha256').update(`${raw}|${s}`).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/* ──────────────────────────────────────────────────────────────
 * 四、每群状态
 * ────────────────────────────────────────────────────────────── */

/** 空状态。 */
export function emptyState(dateKey) {
  return {
    date: dateKey || '',
    dailyCount: 0,
    lastAt: 0,
    lastPrizeKey: '',
    pityCounter: 0,
    lastCycleId: '',
    byUser: {},
    pendingInvite: null,
  };
}

/**
 * 读某群状态。**永不返回 null**。
 *
 * 自愈规则：
 *   · 文件不存在/损坏 → 空状态
 *   · lastAt 远超未来（时钟回拨）→ 重置
 *   · 字段类型非法 → 单独回落
 *
 * @param {string} gid
 * @param {number} [nowMs]
 * @param {string} [timezone]
 * @returns {ReturnType<typeof emptyState>}
 */
export function readState(gid, nowMs, timezone) {
  const file = stateFile(gid);
  const raw = readJsonSafe(file);
  if (!raw) return emptyState('');

  // 时钟回拨：lastAt 在未来超过 5 分钟 → 整体重置
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lastAt = Number(raw.lastAt);
  if (Number.isFinite(lastAt) && lastAt > now + 5 * 60 * 1000) {
    diag(`[状态] gid=${safeGid(gid)} 时钟回拨 lastAt=${lastAt} now=${now} → 重置`);
    return emptyState('');
  }

  const byUser = {};
  if (raw.byUser && typeof raw.byUser === 'object') {
    for (const [k, v] of Object.entries(raw.byUser)) {
      if (!v || typeof v !== 'object') continue;
      const key = String(k).replace(/[^A-Za-z0-9]/g, '');
      if (!key) continue;
      const count = Number(v.count);
      byUser[key] = {
        date: typeof v.date === 'string' ? v.date : '',
        count: Number.isFinite(count) && count >= 0 ? Math.round(count) : 0,
      };
    }
  }

  let pendingInvite = null;
  if (raw.pendingInvite && typeof raw.pendingInvite === 'object') {
    const at = Number(raw.pendingInvite.at);
    const cycleId = String(raw.pendingInvite.cycleId ?? '');
    if (Number.isFinite(at) && at > 0 && cycleId) {
      pendingInvite = {
        cycleId,
        at,
        cardId: String(raw.pendingInvite.cardId ?? ''),
      };
    }
  }

  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    dailyCount: nonNegInt(raw.dailyCount),
    lastAt: Number.isFinite(lastAt) ? lastAt : 0,
    lastPrizeKey: typeof raw.lastPrizeKey === 'string' ? raw.lastPrizeKey : '',
    pityCounter: nonNegInt(raw.pityCounter),
    lastCycleId: typeof raw.lastCycleId === 'string' ? raw.lastCycleId : '',
    byUser,
    pendingInvite,
  };
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * 写某群状态（原子）。
 *
 * @returns {boolean}
 */
export function writeState(gid, state) {
  if (!state || typeof state !== 'object') return false;
  return writeJsonAtomic(stateFile(gid), state);
}

/**
 * 跨天重置：若 state.date 不是今天，把每日计数清零。
 *
 * @returns {{state:object, reset:boolean}}
 */
export function rolloverIfNeeded(state, nowMs, timezone, dateKeyFn) {
  const today = typeof dateKeyFn === 'function' ? dateKeyFn(nowMs, timezone) : String(state?.date ?? '');
  const s = state && typeof state === 'object' ? { ...state } : emptyState(today);
  if (s.date === today) return { state: s, reset: false };

  s.date = today;
  s.dailyCount = 0;
  // byUser 也按日重置（只保留今天有记录的）
  const nextUsers = {};
  for (const [k, v] of Object.entries(s.byUser || {})) {
    if (v && v.date === today) nextUsers[k] = v;
  }
  s.byUser = nextUsers;
  return { state: s, reset: true };
}

/* ──────────────────────────────────────────────────────────────
 * 五、全局小时计数（跨群护栏）
 * ────────────────────────────────────────────────────────────── */

/**
 * 读全局计数。跨小时自动归零。
 *
 * @param {number} nowMs
 * @param {string} timezone
 * @param {(n:number,tz:string)=>string} dateKeyFn
 * @param {(n:number,tz:string)=>number} hourFn
 * @returns {{hourlyCount:number, hourKey:string}}
 */
export function readGlobalStats(nowMs, timezone, dateKeyFn, hourFn) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const dateKey = typeof dateKeyFn === 'function' ? dateKeyFn(now, timezone) : '';
  const hour = typeof hourFn === 'function' ? hourFn(now, timezone) : 0;
  const hourKey = `${dateKey}T${String(hour).padStart(2, '0')}`;

  const raw = readJsonSafe(globalFile());
  if (!raw) return { hourlyCount: 0, hourKey };
  if (raw.hourKey !== hourKey) return { hourlyCount: 0, hourKey };

  return { hourlyCount: nonNegInt(raw.hourlyCount), hourKey };
}

/**
 * 全局计数 +1（跨小时先归零）。
 *
 * @returns {boolean}
 */
export function bumpGlobalStats(nowMs, timezone, dateKeyFn, hourFn) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const dateKey = typeof dateKeyFn === 'function' ? dateKeyFn(now, timezone) : '';
  const hour = typeof hourFn === 'function' ? hourFn(now, timezone) : 0;
  const hourKey = `${dateKey}T${String(hour).padStart(2, '0')}`;

  const raw = readJsonSafe(globalFile());
  const prev = raw && raw.hourKey === hourKey ? nonNegInt(raw.hourlyCount) : 0;
  return writeJsonAtomic(globalFile(), { hourKey, hourlyCount: prev + 1, updatedAt: now });
}

/* ──────────────────────────────────────────────────────────────
 * 六、邀请过期清理
 * ────────────────────────────────────────────────────────────── */

/**
 * 判断邀请是否已过期。
 *
 * @param {{pendingInvite:object|null}} state
 * @param {number} nowMs
 * @param {number} expireMs
 * @returns {boolean}
 */
export function inviteExpired(state, nowMs, expireMs) {
  const inv = state && state.pendingInvite;
  if (!inv || !Number.isFinite(Number(inv.at))) return true;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return now - Number(inv.at) > expireMs;
}

/* ──────────────────────────────────────────────────────────────
 * 七、运维：列出所有群状态（诊断用）
 * ────────────────────────────────────────────────────────────── */

/** 列出状态目录里所有 <gid>.json（诊断/统计用）。 */
export function listStateFiles() {
  try {
    const root = rootDir();
    if (!existsSync(root) || !statSync(root).isDirectory()) return [];
    return readdirSync(root)
      .filter((n) => n.endsWith('.json') && !n.startsWith('_'))
      .map((n) => join(root, n));
  } catch {
    return [];
  }
}

export default {
  rootDir, stateFile, globalFile, atlasDir, atlasFile, diagFile,
  writeTextAtomic, writeJsonAtomic, readJsonSafe, diag, hashOpenid,
  emptyState, readState, writeState, rolloverIfNeeded,
  readGlobalStats, bumpGlobalStats, inviteExpired, listStateFiles,
};
