/**
 * roam/store — 状态读写、去重、缓存、诊断（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 存了什么 / 没存什么
 *   存：每群的限频计数、已看 bvid 列表（LRU）、元数据缓存
 *   ❌ 不存：视频内容、字幕原文、图片 —— 一律不落盘（开源红线）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 健壮性纪律
 *   · 读到坏 JSON → 返回空状态，**绝不抛**（不能让她整条链路挂掉）
 *   · 目录不存在 → 自动建
 *   · 写失败 → 返回 false，**绝不抛**
 *   · 所有路径都在**调用时**解析（dataRoot()），不在模块加载时冻结
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import { appendLogRotating } from '../log-rotate.mjs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir, diagFile, nowMs } from './config.mjs';

/** 诊断日志轮转阈值（512 KB）。 */
const DIAG_ROTATE_BYTES = 512 * 1024;

/** 每个群状态文件名（gid 安全化）。 */
function stateFile(gid) {
  const safe = String(gid ?? '').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 64) || 'unknown';
  return join(stateDir(), safe + '.json');
}

/** 缓存文件路径。 */
function cacheFile(bvid) {
  const safe = String(bvid ?? '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 32) || 'unknown';
  return join(stateDir(), 'cache', safe + '.json');
}

/** 空状态模板。 */
function emptyState() {
  return {
    date: '',
    dailyProactive: 0,
    lastProactiveAt: 0,
    lastResponseAt: 0,
    seen: [],
    byUser: {},
    _recentResponses: [],
    lastWatched: '',
    lastWatchedAt: 0,
  };
}

/** 确保目录存在（失败静默）。 */
function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

/**
 * 读某群状态。永不为 null。
 * @param {string} gid
 * @returns {object}
 */
export function readState(gid) {
  const base = emptyState();
  try {
    const f = stateFile(gid);
    if (!existsSync(f)) return base;
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
    return {
      date: typeof parsed.date === 'string' ? parsed.date : '',
      dailyProactive: Number.isFinite(parsed.dailyProactive) ? Math.max(0, Math.round(parsed.dailyProactive)) : 0,
      lastProactiveAt: Number.isFinite(parsed.lastProactiveAt) ? parsed.lastProactiveAt : 0,
      lastResponseAt: Number.isFinite(parsed.lastResponseAt) ? parsed.lastResponseAt : 0,
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((x) => typeof x === 'string').slice(0, 5000) : [],
      byUser: parsed.byUser && typeof parsed.byUser === 'object' && !Array.isArray(parsed.byUser) ? parsed.byUser : {},
      _recentResponses: Array.isArray(parsed._recentResponses)
        ? parsed._recentResponses.filter((x) => Number.isFinite(x)).slice(-100)
        : [],
      lastWatched: typeof parsed.lastWatched === 'string' ? parsed.lastWatched : '',
      lastWatchedAt: Number.isFinite(parsed.lastWatchedAt) ? parsed.lastWatchedAt : 0,
    };
  } catch {
    return base;
  }
}

/**
 * 原子写某群状态。
 * @param {string} gid
 * @param {object} state
 * @returns {boolean}
 */
export function writeState(gid, state) {
  try {
    if (!ensureDir(stateDir())) return false;
    const target = stateFile(gid);
    const tmp = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2, 8) + '.tmp';
    const data = {
      date: String(state?.date ?? ''),
      dailyProactive: Number.isFinite(state?.dailyProactive) ? state.dailyProactive : 0,
      lastProactiveAt: Number.isFinite(state?.lastProactiveAt) ? state.lastProactiveAt : 0,
      lastResponseAt: Number.isFinite(state?.lastResponseAt) ? state.lastResponseAt : 0,
      seen: Array.isArray(state?.seen) ? state.seen : [],
      byUser: state?.byUser && typeof state.byUser === 'object' ? state.byUser : {},
      _recentResponses: Array.isArray(state?._recentResponses) ? state._recentResponses : [],
      lastWatched: typeof state?.lastWatched === 'string' ? state.lastWatched : '',
      lastWatchedAt: Number.isFinite(state?.lastWatchedAt) ? state.lastWatchedAt : 0,
    };
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 标记一个视频已看（触发 LRU 淘汰）。
 * @returns {boolean} true=新标记；false=之前已看过
 */
export function markSeen(gid, bvid, cfg) {
  const key = String(bvid ?? '').trim();
  if (!key) return false;
  const state = readState(gid);
  const seen = Array.isArray(state.seen) ? state.seen : [];
  if (seen.includes(key)) return false;
  const keep = Number.isFinite(cfg?.seenKeepCount) ? cfg.seenKeepCount : 200;
  const next = [...seen, key];
  while (next.length > keep) next.shift();
  state.seen = next;
  writeState(gid, state);
  return true;
}

/**
 * 记住「该群最近看的是哪一支」。
 *
 * ⚠️ 2026-11-22 真机踩坑：群友引用她的回复说「把这个发卡片」，
 *   但引用文本里没有 BV 号（QQ 引用会截断），模型只能猜 → 发错视频。
 *   所以每次看成功都记一笔，让「这个/刚才那个」有据可依。
 */
export function setLastWatched(gid, bvid) {
  try {
    const state = readState(gid);
    state.lastWatched = String(bvid ?? '').trim();
    state.lastWatchedAt = nowMs();
    return writeState(gid, state);
  } catch { return false; }
}

/** 取该群最近看过的 bvid（没有则空串）。 */
export function getLastWatched(gid) {
  const state = readState(gid);
  return typeof state.lastWatched === 'string' ? state.lastWatched : '';
}

/** 是否看过。 */
export function hasSeen(gid, bvid) {
  const state = readState(gid);
  return Array.isArray(state.seen) && state.seen.includes(String(bvid ?? ''));
}

/** openid → 短哈希（状态里不存真实 openid）。 */
export function hashOpenid(openid) {
  const s = String(openid ?? '').trim();
  if (!s) return '';
  return createHash('sha256').update('roam:' + s).digest('hex').slice(0, 16);
}

/** 记一次主动逛。 */
export function bumpProactive(gid, nowMsValue, dateKey) {
  const state = readState(gid);
  const today = String(dateKey ?? '');
  if (state.date !== today) {
    state.date = today;
    state.dailyProactive = 0;
  }
  state.dailyProactive = (Number.isFinite(state.dailyProactive) ? state.dailyProactive : 0) + 1;
  state.lastProactiveAt = Number.isFinite(nowMsValue) ? nowMsValue : nowMs();
  return writeState(gid, state);
}

/** 记一次被动响应。 */
export function bumpResponse(gid, userKey, nowMsValue, dateKey) {
  const state = readState(gid);
  const today = String(dateKey ?? '');
  const now = Number.isFinite(nowMsValue) ? nowMsValue : nowMs();
  const byUser = state.byUser && typeof state.byUser === 'object' ? state.byUser : {};
  const rec = byUser[userKey];
  const count = rec && rec.date === today && Number.isFinite(rec.count) ? rec.count : 0;
  byUser[userKey] = { date: today, count: count + 1 };
  state.byUser = byUser;
  state.lastResponseAt = now;
  const hourAgo = now - 3600 * 1000;
  const recent = Array.isArray(state._recentResponses) ? state._recentResponses : [];
  state._recentResponses = [...recent.filter((t) => Number.isFinite(t) && t > hourAgo), now].slice(-100);
  return writeState(gid, state);
}

/* ── 元数据缓存 ── */

/** 读缓存；过期或不存在返回 null。 */
export function readCache(bvid, ttlMs) {
  try {
    const f = cacheFile(bvid);
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const at = Number(parsed.at);
    if (!Number.isFinite(at)) return null;
    // ⚠️ ttl=0 必须视为「立即过期」，不能被默认值覆盖（测试与热更新都依赖这点）
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : 3600 * 1000;
    if (ttl <= 0) return null;
    if (nowMs() - at > ttl) return null;
    return parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
  } catch { return null; }
}

/** 写缓存。 */
export function writeCache(bvid, data) {
  try {
    if (!ensureDir(join(stateDir(), 'cache'))) return false;
    writeFileSync(cacheFile(bvid), JSON.stringify({ at: nowMs(), data }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/* ── 诊断日志 ── */

/** 写一行诊断（超过 512KB 轮转一次）。 */
export function diag(line) {
  try {
    const f = diagFile();
    ensureDir(dirname(f));
    try {
      if (existsSync(f) && statSync(f).size > DIAG_ROTATE_BYTES) {
        const old = f + '.1';
        try { unlinkSync(old); } catch { /* 可能不存在 */ }
        renameSync(f, old);
      }
    } catch { /* 轮转失败不影响写入 */ }
    appendLogRotating(f, '[' + new Date(nowMs()).toISOString() + '] ' + String(line) + String.fromCharCode(10));
  } catch {
    // 诊断写不进去绝不能影响主流程
  }
}

/** 测试用：本模块无内存态，占位。 */
export function resetForTest() { /* 无内存态 */ }

export default {
  readState, writeState, markSeen, hasSeen, hashOpenid,
  setLastWatched, getLastWatched,
  bumpProactive, bumpResponse, readCache, writeCache, diag, resetForTest,
};
