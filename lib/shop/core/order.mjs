/**
 * shop/core/order — 点单事务（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是整个小店最容易出错的地方，所以单独成模块并重点测试：
 *
 *   ① **精确库存**：库存 0 时拒绝，绝不出现负数
 *   ② **并发安全**：读-改-写全程持锁（锁在读之前获取）
 *   ③ **三处同时更新**：主存档 / 流水 / 顾客档案
 *   ④ **失败可回滚**：主存档写成功但流水失败 → 不阻断（流水是辅助）
 *
 * 为什么不给模型一个 shop_order 工具：
 *   每次点单多一轮往返（实测比安安 6.8s，再+一轮就 10s+）。
 *   改成「模型在回复里带 <shop:sold item="X" qty="N"> 标记」，
 *   hook 检测到才扣库存 —— 不增加延迟，且只有模型确认成交才扣。
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { ERR, shopErr } from '../errors.mjs';
import { toZonedIso } from '../time.mjs';
import { readState, writeState } from './state.mjs';

/** 标记格式（与 outbound 剥离规则必须一致）。 */
export const SOLD_MARKER_RE = /<shop:sold\s+item="([^"]{1,40})"\s+qty="(\d{1,3})"\s*\/?>/g;

/**
 * 从模型回复里提取点单标记。
 *
 * @param {string} text
 * @returns {Array<{item:string, qty:number}>}
 */
export function parseSoldMarkers(text) {
  const out = [];
  const s = String(text ?? '');
  SOLD_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = SOLD_MARKER_RE.exec(s)) !== null) {
    const item = m[1].trim();
    const qty = Math.max(1, Math.floor(Number(m[2]) || 1));
    if (item) out.push({ item, qty });
  }
  return out;
}

/** 把标记从文本里剥掉（群友不该看到）。 */
export function stripSoldMarkers(text) {
  return String(text ?? '').replace(SOLD_MARKER_RE, '').replace(/\s{2,}/g, ' ').trim();
}

/** 商品名归一化（防"三文治"/"三明治"被当成两个）。 */
const ITEM_ALIASES = {
  三文治: '三明治',
  三明治: '三明治',
  热牛奶: '热牛奶',
  牛奶: '热牛奶',
  饭团: '饭团',
};
export function normItem(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, '');
  return ITEM_ALIASES[n] || n;
}

/**
 * 执行一笔点单（**核心事务**）。
 *
 * @param {object} store   存储适配器
 * @param {string} gid     群 id
 * @param {{openid:string, name:string}} user 下单的人
 * @param {string} itemRaw 商品名（模型给的原始值）
 * @param {number} qty     数量
 * @param {{nowMs:number, timezone:string, allowOversell:boolean, maxRegulars:number, maxCustomerNotes:number}} cfg
 * @returns {Promise<{ok:boolean, reason?:string, left?:number, price?:number}>}
 */
export async function placeOrder(store, gid, user, itemRaw, qty, cfg) {
  const item = normItem(itemRaw);
  const n = Math.max(1, Math.floor(Number(qty) || 1));
  if (!item) return { ok: false, reason: ERR.ITEM_NOT_FOUND };
  if (!user?.openid) return { ok: false, reason: ERR.INVALID_ARG };

  // ★ 锁在读之前获取，锁到写完
  return store.withLock(gid, async () => {
    const s = readState(store, gid);
    if (!s) return { ok: false, reason: ERR.STORE_READ_FAILED };

    const slot = s.dailyStock?.[item];
    if (!slot) return { ok: false, reason: ERR.ITEM_NOT_FOUND };

    const allowOversell = cfg?.allowOversell === true;
    if (!allowOversell && slot.qty < n) {
      return { ok: false, reason: ERR.OUT_OF_STOCK, left: slot.qty };
    }

    // ── 更新主存档 ──
    const price = Number(slot.price) || 0;
    const total = price * n;
    slot.qty = Math.max(0, slot.qty - n);
    s.dailyRevenue = (Number(s.dailyRevenue) || 0) + total;
    s.soldToday = (Number(s.soldToday) || 0) + n;
    s.totalRevenue = (Number(s.totalRevenue) || 0) + total;
    s.totalSold = (Number(s.totalSold) || 0) + n;
    s.soldItems = s.soldItems || {};
    s.soldItems[item] = (Number(s.soldItems[item]) || 0) + n;

    writeState(store, gid, s);   // 原子写；失败会抛 → 整笔失败

    // ── 流水（辅助，失败不阻断）──
    try {
      store.appendHistory(gid, {
        v: 1,
        ts: toZonedIso(cfg?.nowMs ?? Date.now(), cfg?.timezone || 'Asia/Shanghai'),
        t: 'order',
        user: String(user.name ?? '').slice(0, 40),
        openid: user.openid,
        item,
        qty: n,
        price: total,
        left: slot.qty,
      });
    } catch { /* 不阻断 */ }

    // ── 顾客档案（辅助，失败不阻断）──
    try {
      bumpCustomer(store, gid, user, item, n, total, cfg);
    } catch { /* 不阻断 */ }

    return { ok: true, left: slot.qty, price: total };
  });
}

/**
 * 更新顾客档案 + 全局标记。
 * @internal
 */
function bumpCustomer(store, gid, user, item, qty, total, cfg) {
  const nowIso = toZonedIso(cfg?.nowMs ?? Date.now(), cfg?.timezone || 'Asia/Shanghai');
  const maxNotes = Number(cfg?.maxCustomerNotes) > 0 ? Number(cfg.maxCustomerNotes) : 5;

  // ① 群内档案
  let c = null;
  try { c = store.readCustomer(gid, user.openid); } catch { c = null; }
  if (!c) {
    c = {
      version: 1,
      openid: user.openid,
      name: String(user.name ?? '').slice(0, 40),
      groupId: gid,
      firstSeenAt: nowIso,
      orderCount: 0,
      totalSpent: 0,
      prefers: {},
      favorite: null,
      notes: [],
      titles: [],
    };
  }
  c.name = String(user.name ?? c.name ?? '').slice(0, 40);
  c.lastSeenAt = nowIso;
  c.orderCount = (Number(c.orderCount) || 0) + qty;
  c.totalSpent = (Number(c.totalSpent) || 0) + total;
  c.prefers = c.prefers || {};
  c.prefers[item] = (Number(c.prefers[item]) || 0) + qty;

  // 最爱 = 点得最多的那个
  let best = null, bestN = -1;
  for (const [k, v] of Object.entries(c.prefers)) {
    if (v > bestN) { best = k; bestN = v; }
  }
  c.favorite = best;

  // 称号
  const titles = [];
  if (c.orderCount >= 1) titles.push('来过');
  if (c.orderCount >= 5) titles.push('熟客');
  if (c.orderCount >= 15) titles.push('老主顾');
  c.titles = titles;

  // notes 有上限
  if (Array.isArray(c.notes) && c.notes.length > maxNotes) {
    c.notes = c.notes.slice(-maxNotes);
  }

  store.writeCustomer(gid, user.openid, c);

  // ② 全局标记（**只存数字，不含任何群/商品信息**）
  let g = null;
  try { g = store.readGlobal(user.openid); } catch { g = null; }
  if (!g) {
    g = { version: 1, openid: user.openid, totalOrders: 0, acrossGroups: 0, groups: [], firstSeenAt: nowIso };
  }
  g.totalOrders = (Number(g.totalOrders) || 0) + qty;
  g.lastSeenAt = nowIso;
  // acrossGroups 只增不减的计数（不记录具体群 id）
  g.acrossGroups = Math.max(Number(g.acrossGroups) || 0, 1);
  // 注意：**故意不存 groupId 列表** —— 隐私红线
  delete g.groups;

  store.writeGlobal(user.openid, g);
}

/**
 * 记录一条顾客小事（她记的细节）。
 *
 * @param {object} store
 * @param {string} gid
 * @param {string} openid
 * @param {string} text 一句话（≤40 字）
 * @param {{nowMs:number, timezone:string, maxCustomerNotes:number}} cfg
 */
export function noteCustomer(store, gid, openid, text, cfg) {
  const t = String(text ?? '').trim().slice(0, 40);
  if (!t) return false;
  const maxNotes = Number(cfg?.maxCustomerNotes) > 0 ? Number(cfg.maxCustomerNotes) : 5;
  let c = null;
  try { c = store.readCustomer(gid, openid); } catch { c = null; }
  if (!c) return false;
  c.notes = Array.isArray(c.notes) ? c.notes : [];
  c.notes.push({ at: toZonedIso(cfg?.nowMs ?? Date.now(), cfg?.timezone || 'Asia/Shanghai'), text: t });
  if (c.notes.length > maxNotes) c.notes = c.notes.slice(-maxNotes);
  try { store.writeCustomer(gid, openid, c); return true; } catch { return false; }
}