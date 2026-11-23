/**
 * wake-lottery/config — 唤醒抽奖的全部参数（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计红线（与 points/config.mjs、shop/config.mjs 同款）：
 *   ① 不允许硬编码本机路径 —— 数据根由 pack-paths 统一提供
 *   ② 不允许硬编码人格名 / 群 id
 *   ③ 所有时间口径统一走 timezone
 *   ④ 非法配置一律回落默认值，**绝不抛**
 *
 * 配置来源优先级（从高到低）：
 *   1. 环境变量 BNN_WAKELOTTERY_*（测试隔离 / 临时覆盖）
 *   2. {EXT_DATA}/wake-lottery-config.json
 *   3. DEFAULT_CONFIG（本文件）
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 九种奖项的 key（顺序即 docs 顺序，改动需同步接口契约）。 */
export const PRIZE_KEYS = Object.freeze([
  'quote', 'image', 'points', 'sticker',
  'voice', 'song', 'nickname', 'multiplier', 'secret',
]);

/** 稀有度分组。 */
export const RARITY = Object.freeze({
  common: ['quote', 'image', 'points', 'sticker'],
  uncommon: ['voice', 'song'],
  rare: ['nickname', 'multiplier'],
  legendary: ['secret'],
});

/** 所有奖项 key → 稀有度。 */
export const RARITY_OF = Object.freeze({
  quote: 'common', image: 'common', points: 'common', sticker: 'common',
  voice: 'uncommon', song: 'uncommon',
  nickname: 'rare', multiplier: 'rare',
  secret: 'legendary',
});

export const DEFAULT_CONFIG = Object.freeze({
  /** 总开关。默认关闭，灰度开启。 */
  enabled: false,

  /** 时区口径。 */
  timezone: 'Asia/Shanghai',

  /** 装死窗（小时，左闭右开）。这段时间绝不抽。 */
  sleepWindow: { start: 2, end: 6 },

  /** 心跳 cold 至少持续多久才认为「刚睡醒」。 */
  coldMinMs: 20 * 60 * 1000,

  /** 同群两次抽奖的最小间隔。 */
  perGroupCooldownMs: 2 * 60 * 60 * 1000,

  /** 每群每天最多几次。 */
  perGroupDailyCap: 7,

  /** 每人每天最多几次（防一个人包场）。 */
  perUserDailyCap: 3,

  /** 全局每小时最多几个群触发（跨群护栏）。 */
  globalHourlyCap: 5,

  /** 群超过这么久没真人说话，视为死群。 */
  deadGroupMs: 7 * 24 * 60 * 60 * 1000,

  /** 单个出口的兑现超时。 */
  prizeTimeoutMs: 8000,

  /** A（她自抽）占比；1 - 该值 = B（邀请群友）。 */
  selfDrawRatio: 0.5,

  /** 连续这么多次没中稀有，下一次强制稀有。 */
  pityThreshold: 5,

  /** 邀请卡片有效期。 */
  inviteExpireMs: 2 * 60 * 60 * 1000,

  /** 九种奖项的基准权重（和为 100）。 */
  baseWeights: Object.freeze({
    quote: 28, image: 20, points: 14, sticker: 8,
    voice: 14, song: 10, nickname: 3, multiplier: 2, secret: 1,
  }),

  /** 归一化后每项的最低权重（防止某奖项被饿死）。 */
  minWeight: 1,

  /** 是否用八维情绪调整权重。 */
  dimensionTuning: true,

  /** 是否启用图鉴。 */
  atlasEnabled: true,

  /** 加倍券最多能存几张。 */
  maxMultiplierCoupons: 3,

  /** 输出文本字数上限。 */
  outputMaxChars: 60,

  /** 哈希 openid 用的盐。 */
  salt: 'wakelottery',
});

/* ──────────────────────────────────────────────────────────────
 * 类型守卫：每个字段独立的 sanitizer
 * ────────────────────────────────────────────────────────────── */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';

/** 正数，否则回退。 */
function posNum(v, fallback) {
  return isNum(v) && v > 0 ? v : fallback;
}

/** 非负数，否则回退。 */
function nonNegNum(v, fallback) {
  return isNum(v) && v >= 0 ? v : fallback;
}

/** [0,1] 内的数。 */
function ratioNum(v, fallback) {
  if (!isNum(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

/** 正整数。 */
function posInt(v, fallback) {
  if (!isNum(v) || v <= 0) return fallback;
  return Math.max(1, Math.round(v));
}

/** 布尔。 */
function boolVal(v, fallback) {
  return isBool(v) ? v : fallback;
}

/** 非空字符串。 */
function strVal(v, fallback) {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/** 装死窗：两个 0-23 整数，且 start !== end。 */
function sleepWindowVal(v, fallback) {
  if (!v || typeof v !== 'object') return { ...fallback };
  const start = isNum(v.start) ? Math.max(0, Math.min(23, Math.round(v.start))) : fallback.start;
  const end = isNum(v.end) ? Math.max(0, Math.min(24, Math.round(v.end))) : fallback.end;
  if (start === end) return { ...fallback };
  return { start, end };
}

/** 权重表：只认已知 key 的有限非负数，其余忽略；非法值回落默认。 */
function weightsVal(v, fallback, minWeight) {
  const out = {};
  for (const key of PRIZE_KEYS) {
    const raw = v && typeof v === 'object' ? v[key] : undefined;
    const base = fallback[key];
    out[key] = isNum(raw) && raw >= 0 ? raw : base;
  }
  // 全部为 0 时回落默认（否则抽奖无意义）
  const sum = PRIZE_KEYS.reduce((a, k) => a + out[k], 0);
  if (sum <= 0) return { ...fallback };
  // 低于 minWeight 的抬到 minWeight
  for (const key of PRIZE_KEYS) if (out[key] > 0 && out[key] < minWeight) out[key] = minWeight;
  return out;
}

/**
 * 把外部配置（文件/环境变量混合）解析成合法配置。
 *
 * **绝不抛**：任何非法值都回落默认。
 *
 * @param {object|null|undefined} partial
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveConfig(partial) {
  const src = partial && typeof partial === 'object' ? partial : {};
  const D = DEFAULT_CONFIG;

  const minWeight = nonNegNum(src.minWeight, D.minWeight);
  const baseWeights = weightsVal(src.baseWeights, D.baseWeights, minWeight);

  return {
    enabled: boolVal(src.enabled, D.enabled),
    timezone: strVal(src.timezone, D.timezone),
    sleepWindow: sleepWindowVal(src.sleepWindow, D.sleepWindow),
    coldMinMs: posNum(src.coldMinMs, D.coldMinMs),
    perGroupCooldownMs: nonNegNum(src.perGroupCooldownMs, D.perGroupCooldownMs),
    perGroupDailyCap: posInt(src.perGroupDailyCap, D.perGroupDailyCap),
    perUserDailyCap: posInt(src.perUserDailyCap, D.perUserDailyCap),
    globalHourlyCap: posInt(src.globalHourlyCap, D.globalHourlyCap),
    deadGroupMs: posNum(src.deadGroupMs, D.deadGroupMs),
    prizeTimeoutMs: posNum(src.prizeTimeoutMs, D.prizeTimeoutMs),
    selfDrawRatio: ratioNum(src.selfDrawRatio, D.selfDrawRatio),
    pityThreshold: posInt(src.pityThreshold, D.pityThreshold),
    inviteExpireMs: posNum(src.inviteExpireMs, D.inviteExpireMs),
    baseWeights,
    minWeight,
    dimensionTuning: boolVal(src.dimensionTuning, D.dimensionTuning),
    atlasEnabled: boolVal(src.atlasEnabled, D.atlasEnabled),
    maxMultiplierCoupons: posInt(src.maxMultiplierCoupons, D.maxMultiplierCoupons),
    outputMaxChars: posInt(src.outputMaxChars, D.outputMaxChars),
    salt: strVal(src.salt, D.salt),
  };
}

/* ──────────────────────────────────────────────────────────────
 * 环境变量覆盖
 * ────────────────────────────────────────────────────────────── */

/**
 * 从环境变量读取覆盖项（只读已知变量，其余忽略）。
 *
 * 支持：
 *   BNN_WAKELOTTERY_ENABLED       true/false
 *   BNN_WAKELOTTERY_DIMS          true/false（八维调权开关）
 *   BNN_WAKELOTTERY_SELF_RATIO    0..1
 *   BNN_WAKELOTTERY_DAILY_CAP     正整数
 *   BNN_WAKELOTTERY_COOLDOWN_MS   毫秒
 *   BNN_WAKELOTTERY_COLD_MS       毫秒
 *   BNN_WAKELOTTERY_ATLAS         true/false
 *
 * @returns {object} 只含被覆盖的字段
 */
export function envOverrides() {
  const out = {};
  const env = process.env;

  const boolOf = (name) => {
    const v = String(env[name] ?? '').trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    return undefined;
  };
  const numOf = (name) => {
    const v = String(env[name] ?? '').trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const enabled = boolOf('BNN_WAKELOTTERY_ENABLED');
  if (enabled !== undefined) out.enabled = enabled;

  const dims = boolOf('BNN_WAKELOTTERY_DIMS');
  if (dims !== undefined) out.dimensionTuning = dims;

  const atlas = boolOf('BNN_WAKELOTTERY_ATLAS');
  if (atlas !== undefined) out.atlasEnabled = atlas;

  const ratio = numOf('BNN_WAKELOTTERY_SELF_RATIO');
  if (ratio !== undefined) out.selfDrawRatio = ratio;

  const daily = numOf('BNN_WAKELOTTERY_DAILY_CAP');
  if (daily !== undefined) out.perGroupDailyCap = daily;

  const cooldown = numOf('BNN_WAKELOTTERY_COOLDOWN_MS');
  if (cooldown !== undefined) out.perGroupCooldownMs = cooldown;

  const cold = numOf('BNN_WAKELOTTERY_COLD_MS');
  if (cold !== undefined) out.coldMinMs = cold;

  return out;
}

/**
 * 合并默认值 + 文件配置 + 环境变量，得到最终配置。
 *
 * @param {object|null} fileConfig
 * @returns {typeof DEFAULT_CONFIG}
 */
export function loadConfig(fileConfig) {
  const merged = { ...(fileConfig && typeof fileConfig === 'object' ? fileConfig : {}), ...envOverrides() };
  return resolveConfig(merged);
}

export default { DEFAULT_CONFIG, PRIZE_KEYS, RARITY, RARITY_OF, resolveConfig, envOverrides, loadConfig };
