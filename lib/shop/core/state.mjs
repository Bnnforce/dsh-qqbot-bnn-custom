/**
 * shop/core/state — 存档的读写与初始化（2026-11-17）
 *
 * 负责：新建 / 读取 / 迁移 / 切人格重建
 * 不负责：具体业务逻辑（点单、开店由其他模块做）
 *
 * 关键设计：
 *   · 存档版本 v1，公开承诺向后兼容（未来版本必须能读 v1）
 *   · 所有写走 store.withLock（并发安全）
 *   · 读不到 → 初始化新店，不报错
 */

import { ERR, shopErr, toShopError } from '../errors.mjs';
import { toZonedIso, dateKeyOf } from '../time.mjs';
import { DEFAULT_CONFIG } from '../config.mjs';

/** 当前存档版本。 */
export const CURRENT_STATE_VERSION = 1;

/**
 * 迁移存档到当前版本。
 * 公开承诺：v1 的存档未来必须能读 → 这里永远保留 v1 的迁移入口。
 */
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let s = { ...raw };
  const from = Number(s.version) || 1;
  if (from > CURRENT_STATE_VERSION) {
    // 比我们新的存档 —— 不猜字段，原样返回（调用方自行降级）
    return s;
  }
  // v1 → 未来版本时在这里逐步迁移
  // if (s.version === 1) { s.xxx = default; s.version = 2; }
  s.version = CURRENT_STATE_VERSION;
  return s;
}

/**
 * 创建一家新店的初始存档。
 *
 * @param {{groupId:string, shopName:string, personaName:string, menu:Array<{name:string,price:number,qty:number}>, nowMs:number, timezone:string}} p
 */
export function createInitialState(p) {
  const nowIso = toZonedIso(p.nowMs, p.timezone);
  const dailyStock = {};
  for (const item of p.menu || []) {
    const n = String(item?.name ?? '').trim();
    if (!n) continue;
    dailyStock[n] = {
      qty: Math.max(0, Math.floor(Number(item.qty) || 0)),
      price: Math.max(0, Number(item.price) || 0),
    };
  }
  return {
    version: CURRENT_STATE_VERSION,
    groupId: p.groupId,
    shopName: p.shopName,
    openedAt: nowIso,

    day: 1,
    totalRevenue: 0,
    totalSold: 0,

    currentPersona: p.personaName,
    dailyStock,
    dailyRevenue: 0,
    soldToday: 0,
    soldItems: {},

    personaHistory: [
      { persona: p.personaName, from: nowIso, to: null, days: 0, revenue: 0 },
    ],

    lastOpen: null,
    lastClose: null,
    openToday: false,

    recentEvents: [],
    regulars: [],
    stats: { bestDay: null, topItem: null },

    archived: false,
  };
}

/**
 * 读存档；不存在返回 null。
 * @param {object} store
 * @param {string} gid
 */
export function readState(store, gid) {
  try {
    const raw = store.readShop(gid);
    if (!raw) return null;
    return migrateState(raw);
  } catch (e) {
    // 存储读失败 → 当作"没有存档"，让上层初始化新店（不阻断）
    throw toShopError(e, ERR.STORE_READ_FAILED);
  }
}

/**
 * 写存档（必须已持锁）。
 * @param {object} store
 * @param {string} gid
 * @param {object} state
 */
export function writeState(store, gid, state) {
  try {
    store.writeShop(gid, state);
  } catch (e) {
    throw toShopError(e, ERR.STORE_WRITE_FAILED);
  }
}

/**
 * 确保存档存在（不存在就创建）。**内部持锁**。
 *
 * @param {object} store
 * @param {string} gid
 * @param {object} p { personaName, menu, shopName, nowMs, timezone }
 * @returns {Promise<{state:object, created:boolean}>}
 */
export async function ensureState(store, gid, p) {
  return store.withLock(gid, async () => {
    let s = null;
    try { s = readState(store, gid); } catch { s = null; }
    if (s) return { state: s, created: false };

    const fresh = createInitialState({
      groupId: gid,
      shopName: p.shopName,
      personaName: p.personaName,
      menu: p.menu,
      nowMs: p.nowMs ?? Date.now(),
      timezone: p.timezone ?? DEFAULT_CONFIG.timezone,
    });
    writeState(store, gid, fresh);
    try {
      store.appendHistory(gid, {
        v: 1,
        ts: toZonedIso(p.nowMs ?? Date.now(), p.timezone ?? DEFAULT_CONFIG.timezone),
        t: 'create',
        persona: p.personaName,
        shopName: fresh.shopName,
      });
    } catch { /* 流水失败不阻断 */ }
    return { state: fresh, created: true };
  });
}

/**
 * 更新存档（内部持锁 + 读改写）。
 *
 * @param {object} store
 * @param {string} gid
 * @param {(state:object) => (object|void|Promise<object|void>)} mutator
 *        返回新 state 则替换；返回 undefined 则原地修改生效
 * @returns {Promise<object>} 更新后的 state
 */
export async function updateState(store, gid, mutator) {
  return store.withLock(gid, async () => {
    const s = readState(store, gid);
    if (!s) throw shopErr(ERR.STORE_READ_FAILED, '存档不存在', { gid });
    const next = await mutator(s);
    const out = next && typeof next === 'object' ? next : s;
    writeState(store, gid, out);
    return out;
  });
}

/**
 * 切人格时的状态变换（纯函数，便于测试）。
 *
 * 规则（已与主人确认）：
 *   day / totalRevenue / totalSold / shopName  **不变**（店是连续的）
 *   dailyStock                                 **重建**（换货）
 *   dailyRevenue / soldToday / soldItems       **归零**
 *   personaHistory                             补上任期 + 开新任期
 *
 * @param {object} state
 * @param {{toPersona:string, newMenu:Array, nowMs:number, timezone:string}} p
 * @returns {object} 新状态（不改入参）
 */
export function switchPersonaState(state, p) {
  const s = JSON.parse(JSON.stringify(state));
  const nowIso = toZonedIso(p.nowMs, p.timezone);
  const from = s.currentPersona || '';

  // ① 收上一任
  if (Array.isArray(s.personaHistory) && s.personaHistory.length > 0) {
    const last = s.personaHistory[s.personaHistory.length - 1];
    if (last && !last.to) {
      last.to = nowIso;
      const fromMs = Date.parse(last.from);
      const nowMs2 = Date.parse(nowIso);
      last.days = Number.isFinite(fromMs) && Number.isFinite(nowMs2)
        ? Math.max(0, Math.floor((nowMs2 - fromMs) / 86_400_000))
        : (last.days || 0);
      last.revenue = s.dailyRevenue || 0;   // 当日营收记给它
    }
  } else {
    s.personaHistory = [];
  }

  // ② 开新任期
  s.personaHistory.push({ persona: p.toPersona, from: nowIso, to: null, days: 0, revenue: 0 });

  // ③ 换货
  const stock = {};
  for (const it of p.newMenu || []) {
    const n = String(it?.name ?? '').trim();
    if (!n) continue;
    stock[n] = { qty: Math.max(0, Math.floor(Number(it.qty) || 0)), price: Math.max(0, Number(it.price) || 0) };
  }
  s.dailyStock = stock;
  s.dailyRevenue = 0;
  s.soldToday = 0;
  s.soldItems = {};

  // ④ 这些不变（故意不动）：day / totalRevenue / totalSold / shopName / openedAt

  s.currentPersona = p.toPersona;
  return s;
}

/**
 * 判断"今天"是否已经开过店（防重复开店）。
 * @param {object} state
 * @param {number} nowMs
 * @param {string} timezone
 */
export function openedOnDate(state, nowMs, timezone) {
  if (!state?.lastOpen) return false;
  return dateKeyOf(Date.parse(state.lastOpen), timezone) === dateKeyOf(nowMs, timezone);
}