/**
 * roam/ratelimit — 请求限流、退避、熔断（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独一层（实测依据）
 *   2026-11-22 实测：连续 8 次搜索请求后，B站 直接返回 -412 风控。
 *   加退避（pubdate 排序 + 5s 重试 + 1.5s 间隔）后恢复。
 *
 *   所以限流**不是优化项，是必需项**。没有它第一次上线就会被打停。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三种机制
 *   1. 最小间隔（minIntervalMs）—— 全局节流，防突发
 *   2. 退避重试（retryBackoffMs）—— 遇风控 5s→10s→15s
 *   3. 熔断（circuitBreak*）—— 连续失败 N 次后停 M 分钟
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 状态全部在内存（重启即清），不落盘 —— 限流是瞬时限流，不需要持久化。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 上次请求时间（全局，进程内）。 */
let lastRequestAt = 0;

/** 熔断状态：gid → { failures, openUntil }。 */
const circuit = new Map();

/** 睡眠（Ms 由调用方决定，便于测试注入）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 等待到满足最小间隔。
 *
 * @param {object} cfg
 * @param {() => number} [clock] 当前时刻（测试注入）
 */
export async function throttle(cfg, clock) {
  const now = (typeof clock === 'function' ? clock : Date.now)();
  const minGap = Number.isFinite(cfg?.minIntervalMs) ? cfg.minIntervalMs : 1500;
  const elapsed = now - lastRequestAt;
  if (lastRequestAt > 0 && elapsed < minGap) {
    await sleep(minGap - elapsed);
  }
  lastRequestAt = (typeof clock === 'function' ? clock : Date.now)();
}

/**
 * 判断该 gid 是否处于熔断中。
 *
 * @param {string} gid
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isCircuitOpen(gid, nowMs) {
  const rec = circuit.get(String(gid ?? ''));
  if (!rec) return false;
  const until = Number.isFinite(rec.openUntil) ? rec.openUntil : 0;
  if (until <= 0) return false;
  if (nowMs >= until) {
    // 熔断到期，自动恢复
    circuit.delete(String(gid ?? ''));
    return false;
  }
  return true;
}

/** 剩余熔断时间（毫秒）。 */
export function circuitRemainMs(gid, nowMs) {
  const rec = circuit.get(String(gid ?? ''));
  if (!rec) return 0;
  const until = Number.isFinite(rec.openUntil) ? rec.openUntil : 0;
  return Math.max(0, until - nowMs);
}

/**
 * 记录一次失败。
 *
 * @param {string} gid
 * @param {number} nowMs
 * @param {object} cfg
 * @returns {{opened:boolean, failures:number}}
 */
export function recordFailure(gid, nowMs, cfg) {
  const key = String(gid ?? '');
  const rec = circuit.get(key) || { failures: 0, openUntil: 0 };
  rec.failures += 1;

  const threshold = Number.isFinite(cfg?.circuitBreakAfter) ? cfg.circuitBreakAfter : 3;
  const openMs = Number.isFinite(cfg?.circuitBreakMs) ? cfg.circuitBreakMs : 30 * 60 * 1000;

  if (rec.failures >= threshold && rec.openUntil <= nowMs) {
    rec.openUntil = nowMs + openMs;
    circuit.set(key, rec);
    return { opened: true, failures: rec.failures };
  }

  circuit.set(key, rec);
  return { opened: false, failures: rec.failures };
}

/** 记录一次成功（清零失败计数）。 */
export function recordSuccess(gid) {
  const key = String(gid ?? '');
  const rec = circuit.get(key);
  if (rec) {
    rec.failures = 0;
    rec.openUntil = 0;
    if (rec.failures === 0 && rec.openUntil === 0) circuit.delete(key);
  }
}

/**
 * 判断错误是否属于"风控类"（值得退避重试）。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  const code = String(error?.code ?? error?.bilibiliCode ?? '');
  const msg = String(error?.message ?? '');
  if (/-412/.test(code) || /-412/.test(msg)) return true;
  if (/RISK_CONTROL|risk control/i.test(code) || /RISK_CONTROL/.test(msg)) return true;
  if (/timeout|ETIMEDOUT|ECONNRESET|network/i.test(msg)) return true;
  return false;
}

/**
 * 带退避重试地执行一个异步操作。
 *
 * ⚠️ 只对"风控/网络"类错误重试；其他错误（404/403/-101）立即抛。
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} cfg
 * @param {{ onRetry?: (attempt:number, error:unknown, waitMs:number) => void }} [hooks]
 * @returns {Promise<T>}
 */
export async function withBackoff(fn, cfg, hooks) {
  const maxTries = Number.isFinite(cfg?.retryOnRiskControl) ? Math.max(0, cfg.retryOnRiskControl) : 3;
  const backoff = Array.isArray(cfg?.retryBackoffMs) && cfg.retryBackoffMs.length > 0
    ? cfg.retryBackoffMs
    : [5000, 10000, 15000];

  let attempt = 0;
  for (;;) {
    try {
      await throttle(cfg);
      return await fn();
    } catch (error) {
      const canRetry = attempt < maxTries && isRetryable(error);
      if (!canRetry) throw error;

      const waitMs = backoff[Math.min(attempt, backoff.length - 1)];
      attempt += 1;
      try { hooks?.onRetry?.(attempt, error, waitMs); } catch { /* ignore */ }
      await sleep(waitMs);
    }
  }
}

/** 测试用：重置全部内存状态。 */
export function resetForTest() {
  lastRequestAt = 0;
  circuit.clear();
}

export default {
  throttle,
  isCircuitOpen,
  circuitRemainMs,
  recordFailure,
  recordSuccess,
  isRetryable,
  withBackoff,
  resetForTest,
};
