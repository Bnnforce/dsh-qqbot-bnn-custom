/**
 * cycle — 生理周期状态（三相位，**默认关闭**）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 要解决的问题
 *
 *   女性人格没有周期感知，每天语气都一样 —— 少了一层"真实感"。
 *
 * ── 设计原则（这几条是防"每天都不正常"的）────────────────────────────────
 *
 *   ① **默认关闭** —— 要用的人自己开并填起始日（`enabled: false`）
 *   ② **只算不存** —— 纯函数，不写人格卡、不写任何状态
 *   ③ **只输出一句提示** —— 不做情绪数值联动（那是 R6.4 数字身体的事）
 *   ④ **幅度很小** —— 相位只影响"语气提示"，不改安全规则、不改权限
 *
 * ── 为什么不和 R6.4 数字身体一起做
 *
 *   R6.4 是「6 个标量 + OU 过程 + 文字立绘」，属于完整情绪系统。
 *   本期只做**最简三相位**：知道"这几天"就够了。两者不冲突，
 *   将来 R6.4 可以把 cycle 作为其中一个输入。
 *
 * ── 相位定义 ──────────────────────────────────────────────────────────────
 *
 *   以 28 天为默认周期，起始日 = 用户填的日期（经期第一天）
 *
 *   day 1-5    period   经期
 *   day 6-13   normal   平常
 *   day 14-20  normal   平常（排卵期，不给提示，避免过度解读）
 *   day 21-28  pms      经前
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const PHASE = Object.freeze({
  NORMAL: 'normal',
  PMS: 'pms',
  PERIOD: 'period',
});

export const CYCLE_DEFAULTS = Object.freeze({
  enabled: false,            // ★ 默认关闭
  cycleDays: 28,
  periodDays: 5,
  pmsDays: 8,                // 经前 8 天
  /** 起始日（经期第一天），'YYYY-MM-DD'。开功能时必须填。 */
  startDate: '',
});

/** 把 'YYYY-MM-DD' 解析成本地零点的时间戳。 */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return NaN;
  const [, y, mo, d] = m;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** 两个时间戳之间差几个自然日（向下取整，忽略时分秒）。 */
export function daysBetween(fromMs, toMs) {
  // 2026-11-24 修：原来直接 Math.floor(ms/86400000)，
  // 会把「同一天的 00:00 和 12:00」算成相差 1 天（跨了零点）。
  // 正确做法：两个时间都归一化到本地零点再算。
  const localMidnight = (ms) => {
    const d = new Date(Number(ms));
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  };
  const a = localMidnight(fromMs);
  const b = localMidnight(toMs);
  return Math.round((b - a) / 86400000);
}

/**
 * 算当前相位。纯函数。
 *
 * @param {object} cfg  { enabled, cycleDays, periodDays, pmsDays, startDate }
 * @param {number} [now]
 * @returns {{ phase: string, dayInCycle: number, cycleDay: number, hint: string, active: boolean }}
 */
export function phaseOf(cfg = CYCLE_DEFAULTS, now = Date.now()) {
  const c = { ...CYCLE_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const off = { phase: PHASE.NORMAL, dayInCycle: 0, cycleDay: 0, hint: '', active: false };

  // 关闭 / 没填起始日 / 参数非法 → 一律 normal 且不注入
  if (c.enabled !== true) return off;
  const start = parseDay(c.startDate);
  if (!Number.isFinite(start)) return off;
  const cycle = Math.max(7, Math.min(90, Math.floor(Number(c.cycleDays) || 28)));
  const periodDays = Math.max(1, Math.min(cycle, Math.floor(Number(c.periodDays) || 5)));
  const pmsDays = Math.max(1, Math.min(cycle, Math.floor(Number(c.pmsDays) || 8)));

  const diff = daysBetween(start, now);
  if (diff < 0) return off;                       // 起始日在未来 → 不启用
  const cycleDay = (diff % cycle) + 1;            // 1..cycle

  if (cycleDay <= periodDays) {
    return {
      phase: PHASE.PERIOD,
      dayInCycle: cycleDay,
      cycleDay,
      active: true,
      hint: '这几天身体不太舒服，说话会短一点、懒一点，别太闹。',
    };
  }
  // 经前：周期末尾 pmsDays 天
  if (cycleDay > cycle - pmsDays) {
    return {
      phase: PHASE.PMS,
      dayInCycle: cycleDay,
      cycleDay,
      active: true,
      hint: '这两天容易烦，说话会冲一点，别往心里去。',
    };
  }
  return { ...off, cycleDay, active: true };      // 平常期：active 但 hint 空
}

/**
 * 校验配置是否可用（给 doctor / 设置校验用）。
 *
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validateCycleConfig(cfg = {}) {
  const reasons = [];
  if (cfg.enabled !== true) return { ok: true, reasons };   // 关着就是合法
  const start = parseDay(cfg.startDate);
  if (!Number.isFinite(start)) reasons.push('开启了周期但 startDate 不是合法日期（要 YYYY-MM-DD）');
  const cycle = Number(cfg.cycleDays);
  if (Number.isFinite(cycle) && (cycle < 7 || cycle > 90)) reasons.push('cycleDays 应在 7-90');
  return { ok: reasons.length === 0, reasons };
}

export default { PHASE, CYCLE_DEFAULTS, phaseOf, parseDay, daysBetween, validateCycleConfig };
