/**
 * shop/lock — 单进程内 keyed 互斥锁（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要：
 *
 *   小店的写操作是「读-改-写」全量重写 JSON：
 *     请求1 读 state(库存=1) → 扣到 0 → 写
 *     请求2 读 state(库存=1) → 扣到 0 → 写     ← 都读到 1，卖了两份
 *
 *   实测并发压力极低（群消息同一秒最多 1 人说话），但两个来源会撞：
 *     · 任务中心定时开店
 *     · 群友点单
 *
 * 关键约束：
 *   **锁必须在「读」之前获取，锁到「写」之后释放。**
 *   只锁写没用 —— 两个请求都已经读到旧值了。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { shopErr, ERR } from './errors.mjs';

/** key → 当前持有者 Promise。 */
const locks = new Map();

/**
 * 在锁内执行 fn。
 *
 * @param {string} key 锁粒度（小店场景用 groupId）
 * @param {() => Promise<any>} fn 要执行的事务
 * @param {{timeoutMs?: number}} opts 等待超时
 * @returns {Promise<any>} fn 的返回值
 */
export async function withLock(key, fn, opts = {}) {
  const k = String(key ?? '');
  if (!k) throw shopErr(ERR.INVALID_ARG, 'withLock 需要 key');

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10_000;
  const deadline = Date.now() + timeoutMs;

  // 等前面的释放（可能排队多个）
  // ⚠️ 超时判定要在「等待的同时」生效 —— 只在前置 if 里判会漏：
  //    前一个锁可能一直不释放，await 永远不返回，循环体里的 if 根本没机会执行。
  while (locks.has(k)) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      throw shopErr(ERR.LOCK_TIMEOUT, `等待锁超时: ${k}`, { key: k, timeoutMs });
    }
    const holder = locks.get(k);
    // Promise.race：要么前一个释放，要么超时
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), remain);
      timer.unref?.();
    });
    let outcome;
    try {
      outcome = await Promise.race([
        holder.then(() => 'released', () => 'released'),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome === '__timeout__') {
      throw shopErr(ERR.LOCK_TIMEOUT, `等待锁超时: ${k}`, { key: k, timeoutMs });
    }
  }

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  locks.set(k, done);

  try {
    return await fn();
  } finally {
    locks.delete(k);
    resolveDone();
  }
}

/** 当前被锁住的 key（诊断用）。 */
export function lockedKeys() {
  return [...locks.keys()];
}

/** 测试用：清空所有锁（只在测试里调）。 */
export function _resetLocks() {
  locks.clear();
}