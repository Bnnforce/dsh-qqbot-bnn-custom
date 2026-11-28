/**
 * points/spend — 积分消费（2026-11-17）
 *
 * 唯一出口：小店点单。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 关键：事务顺序（源自审查报告的死锁分析）
 *
 *   小店 order() 内部持 `withLock(gid)`，积分持 `withLock(openid)`。
 *   如果嵌套会死锁：
 *     用户1: 锁 gid_A → 等 openid_X
 *     用户2: 锁 openid_X → 等 gid_A
 *
 *   所以本模块**只做自己的事**，不调用 shop.order()：
 *     ① 调用方先 pay()（锁 openid，独立事务）
 *     ② 再 shop.order()（锁 gid，独立事务）
 *     ③ 库存失败 → 调用 refund()
 *
 *   两把锁永不嵌套。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { shopErr, ERR } from '../pure/errors.mjs';

/**
 * 扣分。
 *
 * @param {object} store 积分存储
 * @param {{openid:string, name?:string, price:number, reason?:string, nowMs?:number}} p
 * @returns {Promise<{ok:boolean, reason?:string, balance:number, paid?:number}>}
 */
export async function pay(store, p) {
  const nowMs = p.nowMs ?? Date.now();
  const price = Math.max(0, Math.floor(Number(p.price) || 0));
  if (price === 0) {
    const cur = store.read(p.openid);
    return { ok: true, balance: Number(cur?.balance) || 0, paid: 0 };
  }

  try {
    const d = await store.update(p.openid, (data) => {
      const bal = Number(data.balance) || 0;
      if (bal < price) {
        throw shopErr(ERR.OUT_OF_STOCK, '积分不够', { need: price, have: bal });
      }
      const at = new Date(nowMs).toISOString();
      data.balance = bal - price;
      data.stats.totalSpent = (Number(data.stats.totalSpent) || 0) + price;
      data.stats.lastActiveAt = at;
      store.pushLedger(data, {
        at, type: 'spend', delta: -price, balance: data.balance,
        reason: String(p.reason ?? '').slice(0, 40),
      });
      return data;
    }, { name: p.name, nowIso: new Date(nowMs).toISOString() });

    return { ok: true, balance: d.balance, paid: price };
  } catch (e) {
    if (e?.code === ERR.OUT_OF_STOCK) {
      const cur = store.read(p.openid);
      return { ok: false, reason: 'NO_MONEY', balance: Number(cur?.balance) || 0 };
    }
    throw e;
  }
}

/**
 * 退款（点单失败时回滚）。
 *
 * @param {object} store
 * @param {{openid:string, name?:string, amount:number, reason?:string, nowMs?:number}} p
 */
export async function refund(store, p) {
  const nowMs = p.nowMs ?? Date.now();
  const amount = Math.max(0, Math.floor(Number(p.amount) || 0));
  if (amount === 0) return { ok: true, balance: store.read(p.openid)?.balance ?? 0 };

  const d = await store.update(p.openid, (data) => {
    const at = new Date(nowMs).toISOString();
    data.balance = (Number(data.balance) || 0) + amount;
    // 退款冲减 spent，不算 earn
    data.stats.totalSpent = Math.max(0, (Number(data.stats.totalSpent) || 0) - amount);
    data.stats.lastActiveAt = at;
    store.pushLedger(data, {
      at, type: 'refund', delta: amount, balance: data.balance,
      reason: String(p.reason ?? '').slice(0, 40),
    });
    return data;
  }, { name: p.name, nowIso: new Date(nowMs).toISOString() });

  return { ok: true, balance: d.balance };
}

/**
 * 「先扣分 → 再执行 → 失败退款」的组合事务。
 *
 * 用法：
 *   const r = await payThenRun(store, {openid, price, reason}, async () => {
 *     return await shop.order(gid, user, item, 1);   // 返回 {ok:boolean}
 *   });
 *
 * @param {object} store
 * @param {{openid:string, name?:string, price:number, reason?:string, nowMs?:number}} payOpts
 * @param {() => Promise<{ok:boolean, [k:string]:any}>} run
 */
export async function payThenRun(store, payOpts, run) {
  // ① 扣分（锁 openid，独立事务）
  const payRes = await pay(store, payOpts);
  if (!payRes.ok) return { ok: false, reason: 'NO_MONEY', balance: payRes.balance };

  // ② 执行（锁 gid，独立事务）
  let runRes;
  try {
    runRes = await run();
  } catch (e) {
    // 执行抛错 → 退款
    await refund(store, {
      openid: payOpts.openid, name: payOpts.name,
      amount: payRes.paid, reason: `退款:${payOpts.reason || ''}`, nowMs: payOpts.nowMs,
    }).catch(() => {});
    throw e;
  }

  // ③ 失败 → 退款
  if (!runRes?.ok) {
    const back = await refund(store, {
      openid: payOpts.openid, name: payOpts.name,
      amount: payRes.paid, reason: `退款:${payOpts.reason || ''}`, nowMs: payOpts.nowMs,
    }).catch(() => ({ balance: payRes.balance }));
    // ★ 顺序重要：refunded 必须在展开后赋值，否则被 runRes 里的同名字段覆盖
    return { ...runRes, balance: back.balance, refunded: true, ok: false };
  }

  return { ...runRes, balance: payRes.balance, paid: payRes.paid };
}
