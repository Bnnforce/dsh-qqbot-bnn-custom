/**
 * points/config — 积分系统的全部参数（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计红线（与 shop/config.mjs 同款）：
 *   ① 不允许硬编码本机路径 —— dataRoot 由调用方注入
 *   ② 不允许硬编码人格名 / 群 id
 *   ③ 所有时间口径统一走 timezone
 *
 * 经济参数已按实测校准（见 Bot/维护/积分方案-审查报告-20261117.md）：
 *   抽签期望 2.625（逐档计算验证）
 *   猜拳期望 0.333/次（赢1/3×2 + 平1/3×0 + 输1/3×−1）
 *   全勤日产出 14.29 / 常见 7.63 / 最低 5.00
 *   定价 8/14/25 → 常见买基础净 −0.37、全勤买常规净 +0.29（双最优）
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const DEFAULT_POINTS_CONFIG = {
  enabled: true,

  // ── 时间 ──
  timezone: 'Asia/Shanghai',

  // ── 获取：签到 ──
  checkinPoints: 5,

  // ── 获取：抽签（score 1-10 → 积分）──
  /** index = score，数组 [0] 占位不用。期望值 2.625。 */
  fortunePoints: [0, 0, 0, 1, 1, 2, 3, 3, 4, 5, 5],
  //              ↑1↑2↑3↑4↑5↑6↑7↑8↑9↑10
  // score:       1→0  2→0  3→1  4→1  5→2  6→3  7→3  8→4  9→5  10→5

  // ── 获取：猜拳 ──
  rpsWinPoints: 2,
  rpsTiePoints: 0,
  rpsLosePoints: -1,
  /** 输了最多扣到 0（不允许负余额）。 */
  rpsAllowNegative: false,

  // ── 获取：骰子 ──
  dicePoints: 1,

  // ── 限次（每个玩法每天最多几次有分）──
  perGameDailyCap: 5,
  /**
   * 同一玩法两次得分之间的冷却。
   * ★ 2026-11-17 主人明确：「不限制分数上限，只限制拿分次数，每个玩法 5 次上限」
   *   → 冷却默认设为 0（即**不启用**）。保留这个字段是为了将来真需要时能开。
   */
  playCooldownMs: 0,

  // ── 消费：小店三档定价 ──
  shopPricing: {
    basic: 8,        // 现成的：坚果/海苔/饼干/水果
    normal: 14,      // 热一下：茶/牛奶/咖啡/面包/饭团
    advanced: 25,    // 要做的：三明治/汤/面/甜品
  },

  // ── 特供款 ──
  specialOfferEnabled: true,
  specialOfferPrices: [50, 100],
  specialOfferCount: 1,

  // ── 上限 ──
  /** ledger 保留条数。 */
  maxLedger: 100,
  /** 排行榜显示条数。 */
  leaderboardSize: 5,
  leaderboardEnabled: true,

  // ── 隐私 ──
  /** 余额是否只对自己可见（默认是）。 */
  balancePrivate: true,

  // ── 存档 ──
  stateVersion: 1,
};

/** 深合并（只一层）。 */
export function mergePointsConfig(base = DEFAULT_POINTS_CONFIG, override = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 校验配置（返回错误列表）。 */
export function validatePointsConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['config 不是对象'];
  const int = (k, min) => {
    const v = cfg[k];
    if (!Number.isInteger(v) || v < min) errs.push(`${k} 必须是非负整数`);
  };
  int('checkinPoints', 0);
  int('dicePoints', 0);
  int('perGameDailyCap', 1);
  if (!Array.isArray(cfg.fortunePoints) || cfg.fortunePoints.length !== 11) {
    errs.push('fortunePoints 必须是长度 11 的数组（index 0 占位）');
  } else if (cfg.fortunePoints.some((x) => !Number.isInteger(x) || x < 0)) {
    errs.push('fortunePoints 元素必须是非负整数');
  }
  for (const k of ['basic', 'normal', 'advanced']) {
    const v = cfg.shopPricing?.[k];
    if (!Number.isInteger(v) || v <= 0) errs.push(`shopPricing.${k} 必须是正整数`);
  }
  if (!(cfg.shopPricing.basic < cfg.shopPricing.normal
      && cfg.shopPricing.normal < cfg.shopPricing.advanced)) {
    errs.push('shopPricing 必须满足 basic < normal < advanced');
  }
  return errs;
}

/** score(1-10) → 积分。 */
export function fortunePointsOf(cfg, score) {
  const s = Math.max(1, Math.min(10, Math.floor(Number(score) || 0)));
  const arr = cfg?.fortunePoints;
  if (!Array.isArray(arr) || arr.length < 11) return 0;
  return Math.max(0, Number(arr[s]) || 0);
}
