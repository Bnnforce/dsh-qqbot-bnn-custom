/**
 * points/outlets — 积分出口注册表（2026-11-18 R5.1）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有出口：
 *
 *   R5.0 上线时，积分**只有一个出口**（小店买吃的）。
 *   攒了分没处花 ⇒ 积分失去意义 ⇒ 签到/抽签/猜拳的动力下降。
 *
 *   本目录把"花积分"做成**可插拔的出口**，每个出口一个文件。
 *
 * ── 出口契约 ────────────────────────────────────────────────────────────────
 *   export default {
 *     id: 'song',                  // 唯一 id
 *     name: '点歌',                // 显示名
 *     price: 20,                   // 价格（分）
 *     enabled: true,               // 开关
 *     description: '让她推荐一首歌',
 *     /** 执行（**已扣分**，这里只做业务） *\/
 *     async run({ pts, openid, name, gid, args }) {
 *       return { ok: true, text: '...' };
 *     },
 *   };
 *
 * ── 工业化纪律 ──────────────────────────────────────────────────────────────
 *   · 每个出口**不自己扣分**（由调用方統一 payThenRun，防重复/防漏退款）
 *   · 失败必须返回 { ok:false, reason } 而不是抛
 *   · 所有出口的运行时成本 = 0（纯本地，不调 LLM）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import lottery from './lottery.mjs';

/** 全部出口（顺序即显示顺序）。 */
export const OUTLETS = [lottery];

/**
 * 按 id 找出口。
 * @param {string} id
 * @returns {object|null}
 */
export function outletOf(id) {
  const k = String(id ?? '').trim();
  if (!k) return null;
  return OUTLETS.find((x) => x.id === k) || null;
}

/**
 * 可用出口列表（过滤掉关闭的）。
 * @param {object} [cfg]
 */
export function availableOutlets(cfg) {
  return OUTLETS.filter((x) => {
    if (x.enabled === false) return false;
    const pref = cfg?.outlets?.[x.id];
    if (pref && pref.enabled === false) return false;
    return true;
  });
}

/**
 * 计算某出口的实际价格（支持配置覆盖）。
 * @param {object} outlet
 * @param {object} [cfg]
 */
export function priceOf(outlet, cfg) {
  const pref = cfg?.outlets?.[outlet?.id];
  const v = Number(pref?.price);
  if (Number.isInteger(v) && v > 0) return v;
  return Number(outlet?.price) || 0;
}