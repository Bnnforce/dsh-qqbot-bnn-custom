/**
 * shop/core/daycycle — 开店 / 打烊（2026-11-17）
 *
 * 每天两次的核心事务。要处理：
 *   · 防重复开店（openToday）
 *   · 补跑（启动时发现今天该开没开）
 *   · 切人格（开店时若人格变了要重建菜单）
 *   · 打烊算 stats
 */

import { ERR, shopErr } from '../errors.mjs';
import { toZonedIso, dateKeyOf } from '../time.mjs';
import { readState, writeState } from './state.mjs';

/**
 * 开店（**核心事务**）。
 *
 * @param {object} store
 * @param {string} gid
 * @param {{menu:Array, personaName:string, nowMs:number, timezone:string, silent:boolean}} p
 * @returns {Promise<{ok:boolean, reason?:string, state?:object, switchedPersona?:boolean}>}
 */
export async function openShop(store, gid, p) {
  return store.withLock(gid, async () => {
    const s = readState(store, gid);
    if (!s) return { ok: false, reason: ERR.STORE_READ_FAILED };

    const nowIso = toZonedIso(p.nowMs, p.timezone);

    // 今天已经开过 → 跳过（防重复）
    if (s.lastOpen) {
      try {
        if (dateKeyOf(Date.parse(s.lastOpen), p.timezone) === dateKeyOf(p.nowMs, p.timezone)) {
          return { ok: false, reason: 'already-open', state: s };
        }
      } catch { /* 日期解析失败当作没开过 */ }
    }

    // 人格变了 → 重建菜单 + 记任期
    let switched = false;
    if (p.personaName && s.currentPersona && p.personaName !== s.currentPersona) {
      // ① 收上一任
      const hist = Array.isArray(s.personaHistory) ? s.personaHistory : [];
      const last = hist[hist.length - 1];
      if (last && !last.to) {
        last.to = nowIso;
        last.revenue = Number(s.dailyRevenue) || 0;
      }
      // ② 开新任期
      hist.push({ persona: p.personaName, from: nowIso, to: null, days: 0, revenue: 0 });
      s.personaHistory = hist;
      s.currentPersona = p.personaName;
      switched = true;
    }

    // 重建今日库存（无论是否切人格，新的一天都要换新的）
    const stock = {};
    for (const it of p.menu || []) {
      const n = String(it?.name ?? '').trim();
      if (!n) continue;
      stock[n] = {
        qty: Math.max(0, Math.floor(Number(it.qty) || 0)),
        price: Math.max(0, Number(it.price) || 0),
      };
    }
    if (Object.keys(stock).length === 0) {
      return { ok: false, reason: ERR.MENU_UNAVAILABLE, state: s };
    }
    s.dailyStock = stock;
    s.dailyRevenue = 0;
    s.soldToday = 0;
    s.soldItems = {};

    // ★ day 递增规则（2026-11-17 修）：
    //   刚创建的存档 day 已经是 1（首次开店算第 1 天），不能再 +1。
    //   只有「已存在且之前开过店」的情况才 +1。
    const isFirstOpen = !s.lastOpen;
    if (!isFirstOpen) s.day = (Number(s.day) || 0) + 1;
    s.lastOpen = nowIso;
    s.openToday = true;

    writeState(store, gid, s);

    try {
      store.appendHistory(gid, {
        v: 1, ts: nowIso, t: 'open', persona: s.currentPersona,
        day: s.day, stock: Object.keys(stock),
        switched: switched || undefined,
        silent: p.silent || undefined,
      });
    } catch { /* 不阻断 */ }

    return { ok: true, state: s, switchedPersona: switched };
  });
}

/**
 * 打烊（**核心事务**）。
 *
 * @param {object} store
 * @param {string} gid
 * @param {{nowMs:number, timezone:string}} p
 * @returns {Promise<{ok:boolean, reason?:string, state?:object, revenue?:number, sold?:number}>}
 */
export async function closeShop(store, gid, p) {
  return store.withLock(gid, async () => {
    const s = readState(store, gid);
    if (!s) return { ok: false, reason: ERR.STORE_READ_FAILED };

    const nowIso = toZonedIso(p.nowMs, p.timezone);

    // 没开店 → 不用打烊
    if (!s.openToday) return { ok: false, reason: 'not-open', state: s };

    const revenue = Number(s.dailyRevenue) || 0;
    const sold = Number(s.soldToday) || 0;

    // 更新 stats
    s.stats = s.stats || { bestDay: null, topItem: null };
    const todayKey = dateKeyOf(p.nowMs, p.timezone);
    if (!s.stats.bestDay || revenue > (Number(s.stats.bestDay.revenue) || 0)) {
      s.stats.bestDay = { date: todayKey, revenue };
    }
    // 销冠（按累计 soldItems 或当前 soldItems？用当前日的）
    let bestItem = '', bestN = -1;
    for (const [k, v] of Object.entries(s.soldItems || {})) {
      if (Number(v) > bestN) { bestItem = k; bestN = Number(v); }
    }
    if (bestItem && (!s.stats.topItem || bestN > (Number(s.stats.topItem.totalSold) || 0))) {
      s.stats.topItem = { name: bestItem, totalSold: bestN };
    }

    s.lastClose = nowIso;
    s.openToday = false;

    writeState(store, gid, s);

    try {
      store.appendHistory(gid, { v: 1, ts: nowIso, t: 'close', revenue, sold, day: s.day });
    } catch { /* 不阻断 */ }

    return { ok: true, state: s, revenue, sold };
  });
}

/**
 * 判断"现在该不该开店"（用于任务决策，不改状态）。
 *
 * @param {{state:object, nowMs:number, timezone:string}} p
 * @returns {{should:boolean, reason:string}}
 */
export function shouldOpenNow(p) {
  const s = p.state;
  if (!s) return { should: true, reason: 'no-state' };   // 没存档 → 该初始化
  if (s.archived) return { should: false, reason: 'archived' };
  if (s.openToday) return { should: false, reason: 'already-open' };
  if (s.lastOpen) {
    try {
      if (dateKeyOf(Date.parse(s.lastOpen), p.timezone) === dateKeyOf(p.nowMs, p.timezone)) {
        return { should: false, reason: 'already-open-today' };
      }
    } catch { /* ignore */ }
  }
  return { should: true, reason: 'new-day' };
}

/**
 * 判断"现在该不该打烊"。
 */
export function shouldCloseNow(p) {
  const s = p.state;
  if (!s) return { should: false, reason: 'no-state' };
  if (s.archived) return { should: false, reason: 'archived' };
  if (!s.openToday) return { should: false, reason: 'not-open' };
  // 今天没卖东西也可以打烊（只是文案不同）
  return { should: true, reason: 'open' };
}