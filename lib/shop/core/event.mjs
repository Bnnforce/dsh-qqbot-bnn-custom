/**
 * shop/core/event — 随机事件（2026-11-17）
 *
 * 事件是"活人感"的关键：不是每天重复，而是**偶尔有意外**。
 *
 * 设计要点：
 *   · 每个事件独立 roll，互不排斥（可能同一天中两个）
 *   · 概率很低（默认 5%），保证"稀有"
 *   · 事件会写进 recentEvents（保留 10 条）和流水
 */

import { ERR, shopErr } from '../errors.mjs';
import { toZonedIso } from '../time.mjs';
import { readState, writeState } from './state.mjs';

/** 事件类型定义。 */
export const EVENT_KINDS = {
  BIG_ORDER: 'bigOrder',      // 大单
  LOSS: 'loss',               // 亏本
  REGULAR: 'regular',         // 回头客
  FAILED_NEW: 'failedNew',    // 新品失败
  BUSY: 'busy',               // 忙不过来
  PRAISED: 'praised',         // 被夸
};

/** 开店时可能触发的事件（跟"今天开始"有关）。 */
const OPEN_EVENTS = [
  { kind: EVENT_KINDS.REGULAR, weight: 1.0 },    // 回头客
  { kind: EVENT_KINDS.FAILED_NEW, weight: 0.8 }, // 新品失败
];

/** 打烊时可能触发的事件（跟"今天结束了"有关）。 */
const CLOSE_EVENTS = [
  { kind: EVENT_KINDS.BIG_ORDER, weight: 1.0 },
  { kind: EVENT_KINDS.LOSS, weight: 0.7 },
  { kind: EVENT_KINDS.BUSY, weight: 0.7 },
  { kind: EVENT_KINDS.PRAISED, weight: 1.2 },
];

/**
 * 为某阶段 roll 一个事件。
 *
 * @param {{phase:'open'|'close', state:object, cfg:object, random?:()=>number}} p
 * @returns {{kind:string, meta:object}|null}
 */
export function rollEvent(p) {
  const cfg = p.cfg || {};
  const random = typeof p.random === 'function' ? p.random : Math.random;
  const baseChance = Number(cfg.eventChance);
  const chance = Number.isFinite(baseChance) ? baseChance : 0.05;

  if (random() >= chance) return null;

  const pool = p.phase === 'close' ? CLOSE_EVENTS : OPEN_EVENTS;
  if (pool.length === 0) return null;

  // 按权重随机
  const totalW = pool.reduce((a, b) => a + b.weight, 0);
  let r = random() * totalW;
  let picked = pool[0];
  for (const e of pool) {
    r -= e.weight;
    if (r <= 0) { picked = e; break; }
  }

  const state = p.state || {};
  const items = Object.keys(state.dailyStock || {});
  const item = items.length > 0 ? items[Math.floor(random() * items.length)] : '';
  const regulars = Array.isArray(state.regulars) ? state.regulars : [];
  const regular = regulars.length > 0 ? regulars[Math.floor(random() * regulars.length)] : null;

  const meta = {
    item,
    qty: 2 + Math.floor(random() * 9),               // 大单数量 2-10
    name: regular?.name || '',
  };

  return { kind: picked.kind, meta };
}

/**
 * 记录事件（写 recentEvents + 流水）。**内部持锁**。
 *
 * @param {object} store
 * @param {string} gid
 * @param {{kind:string, meta?:object, text?:string}} ev
 * @param {{nowMs:number, timezone:string, maxRecentEvents:number}} cfg
 */
export async function recordEvent(store, gid, ev, cfg) {
  return store.withLock(gid, async () => {
    const s = readState(store, gid);
    if (!s) throw shopErr(ERR.STORE_READ_FAILED, '存档不存在', { gid });

    const maxN = Number(cfg?.maxRecentEvents) > 0 ? Number(cfg.maxRecentEvents) : 10;
    const nowIso = toZonedIso(cfg?.nowMs ?? Date.now(), cfg?.timezone || 'Asia/Shanghai');

    s.recentEvents = Array.isArray(s.recentEvents) ? s.recentEvents : [];
    s.recentEvents.push({
      at: nowIso,
      type: ev.kind,
      text: String(ev.text ?? '').slice(0, 60),
    });
    if (s.recentEvents.length > maxN) s.recentEvents = s.recentEvents.slice(-maxN);

    writeState(store, gid, s);

    try {
      store.appendHistory(gid, {
        v: 1, ts: nowIso, t: 'event', kind: ev.kind, text: String(ev.text ?? '').slice(0, 60),
      });
    } catch { /* 流水失败不阻断 */ }

    return s;
  });
}

/**
 * 更新回头客名单（点单达到阈值的人进 regulars）。
 *
 * @param {object} store
 * @param {string} gid
 * @param {string} openid
 * @param {{nowMs:number, timezone:string, maxRegulars:number}} cfg
 */
export async function bumpRegulars(store, gid, openid, cfg) {
  const c = store.readCustomer(gid, openid);
  if (!c) return;
  if (Number(c.orderCount) < 3) return;   // 3 次以上才算回头客

  return store.withLock(gid, async () => {
    const s = readState(store, gid);
    if (!s) return;
    const maxN = Number(cfg?.maxRegulars) > 0 ? Number(cfg.maxRegulars) : 20;
    s.regulars = Array.isArray(s.regulars) ? s.regulars : [];
    const idx = s.regulars.findIndex((r) => r.openid === openid);
    const entry = { openid, name: c.name || '', prefers: c.favorite || '', count: Number(c.orderCount) || 0 };
    if (idx >= 0) s.regulars[idx] = entry;
    else s.regulars.push(entry);
    // 按次数降序，保留前 N
    s.regulars.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
    if (s.regulars.length > maxN) s.regulars = s.regulars.slice(0, maxN);
    writeState(store, gid, s);
  });
}