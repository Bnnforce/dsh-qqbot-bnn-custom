/**
 * shop/errors — 小店的错误分类（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独定义错误码：
 *   ① 机器可读 —— 调用方能按 code 分支处理，不用匹配消息文本
 *   ② 可诊断 —— 每个 code 对应明确的降级策略（见 DEGRADE）
 *   ③ 公开承诺 —— 错误码是契约的一部分，别人部署时要能查
 *
 * 铁律：
 *   **用户永远看不到技术错误，只看到自然语言。**
 *   所有 ShopError 在接入层被翻译成"卖完了""今天没开门"这类话。
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const ERR = {
  // 存储
  STORE_READ_FAILED: 'SHOP_STORE_READ_FAILED',
  STORE_WRITE_FAILED: 'SHOP_STORE_WRITE_FAILED',
  STORE_CORRUPTED: 'SHOP_STORE_CORRUPTED',
  // 业务
  MENU_UNAVAILABLE: 'SHOP_MENU_UNAVAILABLE',
  OUT_OF_STOCK: 'SHOP_OUT_OF_STOCK',
  ITEM_NOT_FOUND: 'SHOP_ITEM_NOT_FOUND',
  // 并发
  LOCK_TIMEOUT: 'SHOP_LOCK_TIMEOUT',
  // 业务状态（积分系统复用）
  ALREADY_DONE: 'SHOP_ALREADY_DONE',
  GAME_CAP: 'SHOP_GAME_CAP',
  // 配置
  CONFIG_INVALID: 'SHOP_CONFIG_INVALID',
  // 其他
  INVALID_ARG: 'SHOP_INVALID_ARG',
};

/**
 * 每个错误码的降级策略（公开文档要照这个写）。
 *
 * degrade：本模块怎么兜底
 * userText：用户会看到什么（natural language）
 * fatal：是否影响功能可用性
 */
export const DEGRADE = {
  [ERR.STORE_READ_FAILED]:   { degrade: '初始化新店', userText: '（无感）', fatal: false },
  [ERR.STORE_WRITE_FAILED]:  { degrade: '本次操作失败，旧数据完好', userText: '（无感，重试）', fatal: false },
  [ERR.STORE_CORRUPTED]:     { degrade: '备份 .corrupt + 重建', userText: '（无感）', fatal: false },
  [ERR.MENU_UNAVAILABLE]:    { degrade: '用兜底菜单', userText: '（无感）', fatal: false },
  [ERR.OUT_OF_STOCK]:        { degrade: '拒绝点单', userText: '卖完了', fatal: false },
  [ERR.ITEM_NOT_FOUND]:      { degrade: '拒绝点单', userText: '今天没这个', fatal: false },
  [ERR.LOCK_TIMEOUT]:        { degrade: '跳过本次', userText: '（静默，不响应）', fatal: false },
  [ERR.CONFIG_INVALID]:      { degrade: '用默认配置', userText: '（无感）', fatal: false },
  [ERR.INVALID_ARG]:         { degrade: '拒绝调用', userText: '（静默）', fatal: false },
  [ERR.ALREADY_DONE]:        { degrade: '拒绝重复操作', userText: '已经做过了', fatal: false },
  [ERR.GAME_CAP]:            { degrade: '拒绝给分（游戏照常）', userText: '今天的分拿满了', fatal: false },
};

/** 小店的错误类型（带机器可读 code + 诊断上下文）。 */
export class ShopError extends Error {
  constructor(code, message, meta) {
    super(message || code);
    this.name = 'ShopError';
    this.code = code;
    this.meta = meta || {};
    /** 是否值得记 warn 级（配置错、存储坏要记；库存不足不用）。 */
    this.warn = ![
      ERR.OUT_OF_STOCK, ERR.ITEM_NOT_FOUND, ERR.INVALID_ARG,
    ].includes(code);
  }
}

/** 快捷构造。 */
export const shopErr = (code, message, meta) => new ShopError(code, message, meta);

/** 把任意异常规整成 ShopError（保底不丢信息）。 */
export function toShopError(err, fallbackCode = ERR.INVALID_ARG) {
  if (err instanceof ShopError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new ShopError(fallbackCode, msg, { cause: msg });
}

/** 是否值得记日志（接入层用）。 */
export function shouldWarn(err) {
  return err instanceof ShopError ? err.warn : true;
}
