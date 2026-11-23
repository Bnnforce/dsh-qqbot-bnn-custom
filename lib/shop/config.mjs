/**
 * shop/config — 小店的全部可配置项（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计红线（为将来公开做准备）：
 *   ① **不允许出现本机绝对路径** —— dataRoot 由调用方注入
 *   ② **不允许出现人格名** —— 一律从 personaProvider 拿
 *   ③ **不允许出现群 id** —— 一律从 ctx 拿
 *   ④ 所有时间口径统一走 timezone，不散落手动 +8h
 *
 * 这些不是"现在的自我要求"，而是让别人的部署不用改代码。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 默认配置（可被调用方覆盖）。 */
export const DEFAULT_CONFIG = {
  // ── 总开关 ──
  enabled: true,

  // ── 时间（统一口径）──
  timezone: 'Asia/Shanghai',
  /** 开店窗口（在窗口内随机挑一分钟）。 */
  openWindow: { startHour: 8, startMin: 0, endHour: 9, endMin: 30 },
  /** 打烊窗口。 */
  closeWindow: { startHour: 21, startMin: 0, endHour: 22, endMin: 30 },

  // ── 说话概率（防"每日播报"）──
  openSpeakChance: 0.7,
  closeSpeakChance: 0.6,

  // ── 让位真实对话 ──
  /** 群内这么多毫秒内有真人说话 → 推迟。 */
  yieldIfActiveWithinMs: 5 * 60_000,
  /** 最多推迟几次，超了就今天不说。 */
  yieldMaxRetries: 3,
  /** 每次推迟多久。 */
  yieldDelayMs: 15 * 60_000,

  // ── 库存 ──
  /** 每天上几种商品。 */
  menuSize: { min: 3, max: 5 },
  /** 每种备多少。 */
  stockPerItem: { min: 8, max: 15 },
  /** 是否允许超卖（false = 精确库存，卖完即止）。 */
  allowOversell: false,

  // ── 她自己的生活（定位：不是"等客人的店"）──
  /** 她自己也消费的概率（写进文案，如"今天自己煮了一壶"）。 */
  selfConsumptionChance: 0.3,
  /** "虚构客人"的概率（如"隔壁来订了两份"）。 */
  fictionalCustomerChance: 0.15,

  // ── 主动事件 ──
  /** 每个事件的基础概率。 */
  eventChance: 0.05,

  // ── 存储上限（防无限膨胀）──
  maxRecentEvents: 10,
  maxRegulars: 20,
  maxCustomerNotes: 5,
  maxShopNameLength: 12,
  /** 归档保留几个月。 */
  archiveMonths: 12,
  /** 群解散后存档保留几天。 */
  deletedShopRetentionDays: 90,

  // ── 静默（群友说烦了就闭嘴）──
  silenceOnComplain: true,
  silenceDurationMs: 3 * 24 * 3600_000,

  // ── 文案 ──
  locale: 'zh-CN',
  /** 是否用 LLM 润色（false = 纯模板）。 */
  useLlmPolish: true,
  /** LLM 润色超时。 */
  llmTimeoutMs: 15_000,

  // ── 存档版本（公开承诺：v1 的存档未来必须能读）──
  stateVersion: 1,
};

/** 深合并配置（只合并一层足够，本模块没有嵌套数组）。 */
export function mergeConfig(base = DEFAULT_CONFIG, override = {}) {
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

/** 校验配置（返回错误列表；空数组 = 合法）。 */
export function validateConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['config 不是对象'];
  if (typeof cfg.enabled !== 'boolean') errs.push('enabled 必须是布尔');
  if (!cfg.timezone || typeof cfg.timezone !== 'string') errs.push('timezone 必须是非空字符串');

  const checkWindow = (name, w) => {
    if (!w) { errs.push(`${name} 缺失`); return; }
    for (const k of ['startHour', 'startMin', 'endHour', 'endMin']) {
      if (!Number.isInteger(w[k]) || w[k] < 0) errs.push(`${name}.${k} 必须是非负整数`);
    }
  };
  checkWindow('openWindow', cfg.openWindow);
  checkWindow('closeWindow', cfg.closeWindow);

  const checkRange = (name, r) => {
    if (!r || !Number.isInteger(r.min) || !Number.isInteger(r.max)) errs.push(`${name} 必须是 {min,max}`);
    else if (r.min > r.max) errs.push(`${name}.min 不能大于 max`);
  };
  checkRange('menuSize', cfg.menuSize);
  checkRange('stockPerItem', cfg.stockPerItem);

  for (const k of ['openSpeakChance', 'closeSpeakChance', 'selfConsumptionChance', 'fictionalCustomerChance', 'eventChance']) {
    const v = cfg[k];
    if (typeof v !== 'number' || v < 0 || v > 1) errs.push(`${k} 必须是 0-1 的数`);
  }
  return errs;
}
