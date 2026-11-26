/**
 * life-stream/pick — 「她此刻在做什么」的纯函数判定（R7.2 · 零 LLM）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么是纯函数、为什么判据这么少
 *
 *   ① 纯函数：同一个 (state, now, recentKinds) 必须永远得到同一个结果。
 *      不读文件、不看表、不要随机 —— 否则「凌晨三点为什么在发呆」这种问题
 *      永远复现不了，线上只能靠猜。
 *
 *   ② 判据只有五条：生活流是个**每群每小时**跑一次的后台动作，
 *      判据越多越容易在某个分支上静默走偏。宁可笨一点、可见一点。
 *
 *   ③ 零 LLM：每小时 ×24 小时 ×3 群 = 72 次/天，模板够用，成本必须是 0。
 *
 * ── 判定优先级（顺序本身就是语义，改顺序 = 改行为） ──────────────────────────
 *   1. 夜间 0-6 点        → 'rest'        （她在睡觉，不可能是别的事）
 *   2. energy < 0.3       → 'rest'        （真的没力气，别硬撑着"想事情"）
 *   3. 整点 minute === 0  → 'check_time'  （真实时间，最扎实的依据）
 *   4. hasHistory === true→ 'recall'      （有旧东西可翻才翻，不编）
 *   5. 其他               → 'idle_think'  （默认：从当前情绪转一句话）
 *
 * ── 防复读机（2026-11-26）────────────────────────────────────────────────────
 *   选中的类型在 recentKinds（最近 3 小时）里已经出现过 ≥2 次 → 降级 'idle_think'。
 *
 *   为什么连 'rest' 一起降级（这条曾经想开后门）：
 *   夜间连续 rest 看着"合理"，但日志里连着四条「夜深了，有点困」就是复读机，
 *   而生活流唯一的消费方是心跳引用 —— 重复的句子被引用的价值是 0。
 *   所以规则对**所有类型**一律生效，不设例外，少一个特例少一个排查方向。
 *   （表现上：凌晨 0/1 点 rest，2 点起降级成 idle_think，读起来像"睡不踏实"。）
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 生活流用到的全部活动类型（含只由其他模块直接渲染的 organize）。 */
export const ACTIVITY_KINDS = Object.freeze([
  'rest',
  'check_time',
  'recall',
  'idle_think',
  'organize',
]);

/** 判定原因（写进日志，方便事后回答「这条为什么是 rest」）。 */
export const PICK_REASONS = Object.freeze({
  NIGHT: 'night',
  LOW_ENERGY: 'low_energy',
  ON_HOUR: 'on_hour',
  HAS_HISTORY: 'has_history',
  DEFAULT: 'default',
  ANTI_REPEAT: 'anti_repeat',
});

/** 深夜区间：左闭右开 [0, 6)。 */
const NIGHT_START_HOUR = 0;
const NIGHT_END_HOUR = 6;

/** 精力低于这个值就休息。 */
const LOW_ENERGY_THRESHOLD = 0.3;

/** 同类型在 recentKinds 里出现到这个次数就降级。 */
const REPEAT_LIMIT = 2;

/**
 * 把 now 归一成 Date。
 *
 * 非法值回落 Date.now()（**不抛**）：生活流是后台动作，
 * 因为一个错的时间戳整条 tick 挂掉，比用当前时间更糟。
 *
 * @param {number|string|Date} now
 * @returns {Date}
 */
function toDate(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now;
  const n = typeof now === 'number' ? now : Number(now);
  if (Number.isFinite(n)) {
    const d = new Date(n);
    if (Number.isFinite(d.getTime())) return d;
  }
  return new Date();
}

/**
 * 取精力值；缺失/非法一律按中性 0.6 处理。
 *
 * ⚠️ 这里**不能**回落 0：读不到状态和「真的没力气」是两件事，
 *    回落 0 会让「状态文件读失败」伪装成「每小时都在睡觉」——
 *    正是本项目最怕的那种静默失败（§16.4）。
 *
 * @param {object} state
 * @returns {number} 0~1
 */
function energyOf(state) {
  const raw = Number(state?.mood?.energy);
  if (!Number.isFinite(raw)) return 0.6;
  return Math.min(1, Math.max(0, raw));
}

/**
 * 统计某个类型在 recentKinds 里出现了几次。
 *
 * @param {string[]|Set<string>} recentKinds
 * @param {string} kind
 * @returns {number}
 */
function countOf(recentKinds, kind) {
  if (!kind) return 0;
  if (recentKinds instanceof Set) {
    let n = 0;
    for (const k of recentKinds) if (k === kind) n += 1;
    return n;
  }
  if (!Array.isArray(recentKinds)) return 0;
  let n = 0;
  for (const k of recentKinds) if (k === kind) n += 1;
  return n;
}

/**
 * 选出此刻的活动类型。
 *
 * @param {{mood?:{energy?:number,mood?:number}, hasHistory?:boolean}} state
 *        情绪状态。缺字段按中性处理，**绝不会抛**。
 * @param {number|string|Date} now 时间戳 / Date
 * @param {string[]} [recentKinds] 最近 3 小时做过的活动类型（旧→新）
 * @returns {'rest'|'check_time'|'recall'|'idle_think'}
 */
export function pickActivity(state, now, recentKinds) {
  return pickActivityTrace(state, now, recentKinds).kind;
}

/**
 * 同 pickActivity，但额外返回判定过程（写日志/写测试用）。
 *
 * @param {object} state
 * @param {number|string|Date} now
 * @param {string[]} [recentKinds]
 * @returns {{kind:string, reason:string, baseKind:string, downgraded:boolean,
 *            energy:number, hour:number, minute:number, repeated:number}}
 */
export function pickActivityTrace(state, now, recentKinds) {
  const d = toDate(now);
  const hour = d.getHours();
  const minute = d.getMinutes();
  const energy = energyOf(state);

  /** ①~⑤ 按优先级选，命中即停。 */
  let baseKind = 'idle_think';
  let reason = PICK_REASONS.DEFAULT;

  if (hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR) {
    baseKind = 'rest';
    reason = PICK_REASONS.NIGHT;
  } else if (energy < LOW_ENERGY_THRESHOLD) {
    baseKind = 'rest';
    reason = PICK_REASONS.LOW_ENERGY;
  } else if (minute === 0) {
    baseKind = 'check_time';
    reason = PICK_REASONS.ON_HOUR;
  } else if (state?.hasHistory === true) {
    baseKind = 'recall';
    reason = PICK_REASONS.HAS_HISTORY;
  }

  /** ⑥ 防复读机：同类已经出现 ≥2 次 → 降级。 */
  const repeated = countOf(recentKinds, baseKind);
  let kind = baseKind;
  let downgraded = false;
  if (baseKind !== 'idle_think' && repeated >= REPEAT_LIMIT) {
    kind = 'idle_think';
    downgraded = true;
    reason = PICK_REASONS.ANTI_REPEAT;
  }

  return { kind, reason, baseKind, downgraded, energy, hour, minute, repeated };
}

export default { ACTIVITY_KINDS, PICK_REASONS, pickActivity, pickActivityTrace };
