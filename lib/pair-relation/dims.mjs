/**
 * pair-relation/dims — 关系三维计算（R7 Stage 3，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 从 R6.7 的「熟/不熟」二元升级为三维：
 *
 *   ① closeness  亲近度   —— 聊得多不多
 *   ② sync       默契度   —— 能不能接上话
 *   ③ tension    张力     —— 有没有别扭
 *
 * ── 铁律（R6.7 定下的红线，这里继续遵守）─────────────────────────────────
 *
 *   **只记可观测的负向信号，绝不判断情绪。**
 *
 *   不判「他们在吵架」（会误判，代价大），只记录：
 *     · unansweredAt —— A @ 了 B，B 在窗口内没回
 *     · coldGap      —— 连续对话突然停止
 *     · slowReply    —— 从快回变成慢回
 *
 *   这些都是**可数的事件**，不是对情绪的主观判断。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 接话窗口：60 秒内回算「默契」。 */
export const FAST_REPLY_MS = 60_000;

/** 慢回阈值：30 分钟以上算「不默契」。 */
export const SLOW_REPLY_MS = 30 * 60_000;

/** @ 之后多久没回算「未回应」。 */
export const UNANSWERED_MS = 10 * 60_000;

/** 张力生效阈值（保守，宁少回避不乱回避）。 */
export const TENSION_THRESHOLD = 0.6;

/** 张力每周衰减系数。 */
export const TENSION_DECAY_PER_WEEK = 0.8;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 亲近度：从互动次数归一化到 0-1。
 *
 * 用对数避免高频霸榜：10 次 → 0.5，100 次 → 1.0。
 *
 * @param {number} interactions
 * @returns {number} 0-1
 */
export function closenessOf(interactions) {
  const n = Math.max(0, Number(interactions) || 0);
  if (n === 0) return 0;
  return Math.min(1, Math.log10(1 + n) / Math.log10(101));
}

/**
 * 默契度：接话越快越默契。
 *
 * @param {{fastReply:number, slowReply:number, interactions:number, echoBack?:number}} sig
 * @returns {number} 0-1
 */
export function syncOf(sig = {}) {
  const fast = Math.max(0, Number(sig.fastReply) || 0);
  const slow = Math.max(0, Number(sig.slowReply) || 0);
  const total = fast + slow;
  const replyPart = total > 0 ? (fast / total) * 0.7 : 0;

  const echo = Math.max(0, Number(sig.echoBack) || 0);
  const inter = Math.max(0, Number(sig.interactions) || 0);
  const echoPart = inter > 0 ? Math.min(1, echo / inter) * 0.3 : 0;

  return Math.min(1, replyPart + echoPart);
}

/**
 * 张力：只从可观测负向信号来。
 *
 * @param {{unansweredAt?:number, coldGap?:number, slowReply?:number}} sig
 * @returns {number} 0-1
 */
export function tensionOf(sig = {}) {
  const un = Math.max(0, Number(sig.unansweredAt) || 0);
  const cg = Math.max(0, Number(sig.coldGap) || 0);
  const sr = Math.max(0, Number(sig.slowReply) || 0);
  return Math.min(1, un * 0.4 + cg * 0.3 + sr * 0.3);
}

/**
 * 张力随时间衰减（别扭会慢慢淡）。
 *
 * @param {number} tension 当前张力
 * @param {number} elapsedMs 经过时间
 * @returns {number} 衰减后的张力
 */
export function decayTension(tension, elapsedMs) {
  const t = Math.max(0, Math.min(1, Number(tension) || 0));
  const weeks = Math.max(0, Number(elapsedMs) || 0) / WEEK_MS;
  return t * Math.pow(TENSION_DECAY_PER_WEEK, weeks);
}

/**
 * 从关系记录算出三维。
 *
 * @param {object} rel 关系记录（含 interactions / signals / tension / updatedAt）
 * @param {number} [now]
 * @returns {{closeness:number, sync:number, tension:number}}
 */
export function dimsOf(rel = {}, now = Date.now()) {
  const close = closenessOf(rel?.interactions);
  const sync = syncOf({
    fastReply: rel?.signals?.fastReply,
    slowReply: rel?.signals?.slowReply,
    interactions: rel?.interactions,
    echoBack: rel?.signals?.echoBack,
  });

  // 张力：先按记录值，再按 updatedAt 到现在的间隔衰减
  const raw = Number.isFinite(rel?.tension) ? rel.tension : tensionOf(rel?.signals);
  const lastAt = Number(rel?.updatedAt) || 0;
  const elapsed = lastAt > 0 && now > lastAt ? now - lastAt : 0;
  const tension = decayTension(raw, elapsed);

  return { closeness: round3(close), sync: round3(sync), tension: round3(tension) };
}

/**
 * 判断「是否该回避同时提到这两人」。
 *
 * ⚠️ 这是张力唯一的使用方式：**只影响「同时提两人」这一种情况**，
 *    不影响正常聊天、不影响单独提任何一人、**绝不向群友解释原因**。
 *
 * @param {object} relations 关系表（pairKey → 记录）
 * @param {string[]} speakers 当前在场的人
 * @param {{threshold?:number}} [opts]
 * @returns {'normal'|'avoid_mention'}
 */
export function toneFor(relations, speakers, opts = {}) {
  const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : TENSION_THRESHOLD;
  const list = Array.isArray(speakers) ? speakers.filter(Boolean) : [];
  if (list.length < 2) return 'normal';

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = String(list[i]);
      const b = String(list[j]);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const rel = relations?.[key];
      if (!rel) continue;
      const t = Number.isFinite(rel.tension) ? rel.tension : tensionOf(rel.signals);
      if (t > threshold) return 'avoid_mention';
    }
  }
  return 'normal';
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

export default {
  FAST_REPLY_MS,
  SLOW_REPLY_MS,
  UNANSWERED_MS,
  TENSION_THRESHOLD,
  closenessOf,
  syncOf,
  tensionOf,
  decayTension,
  dimsOf,
  toneFor,
};
