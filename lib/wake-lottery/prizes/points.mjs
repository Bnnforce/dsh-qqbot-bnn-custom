/**
 * prizes/points — 积分（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 兑现方式：调用积分系统的 refund（ledger 记 type='refund'）。
 *
 *   为什么用 refund 而不是 earn：
 *     earn 会污染「今天赚了多少」的统计；抽奖奖励本质是返还，不是劳动所得。
 *     这与 R5.1 的 /抽奖 保持同一口径。
 *
 * ⚠️ 铁律：**不能假装成功**。写不进去就返回 ok:false，让上层换奖。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { EXT_ROOT } from '../../pack-paths.mjs';
import { POINTS_ROOT } from '../../dirs.mjs';

/**
 * 积分数据根。
 *
 * ⚠️ 2026-11-22 修复：以前直接用模块级常量 POINTS_ROOT。
 *    ESM 的 import 在模块加载时就求值完了，而测试是**先 import 再设环境变量**，
 *    于是 BNN_POINTS_ROOT 永远不生效 → 测试写进生产积分目录（真实污染过）。
 *
 *    改为函数：每次调用时重新读一次，环境变量改了立刻生效。
 */
function pointsRoot() {
  const override = String(process.env.BNN_POINTS_ROOT ?? process.env.DSH_POINTS_ROOT ?? '').trim();
  return override || POINTS_ROOT;
}

/** 单次奖励的积分（可按稀有度区分）。 */
export const POINTS_BY_RARITY = Object.freeze({
  common: 5,
  uncommon: 8,
  rare: 15,
  legendary: 30,
});

let cachedPoints = null;

/** 懒加载积分模块（带缓存击穿，便于热重载）。 */
async function pointsMod() {
  return import(join(EXT_ROOT, 'lib', 'points', 'index.mjs') + `?wl=${Date.now()}`);
}

/**
 * 是否可用：能初始化积分系统即可。
 * @returns {Promise<boolean>}
 */
export async function available() {
  try {
    const { createPoints } = await pointsMod();
    const pts = createPoints({ dataRoot: pointsRoot(), logger: { warn: () => {} } });
    cachedPoints = pts;
    return typeof pts?.refund === 'function';
  } catch {
    return false;
  }
}

/**
 * 发积分。
 *
 * @param {{openid:string, name?:string, random?:()=>number}} ctx
 * @returns {Promise<{ok:true,payload:{kind:'points',content:object}}|{ok:false,reason:string}>}
 */
export async function run(ctx) {
  const openid = String(ctx?.openid ?? '').trim();
  if (!openid) return { ok: false, reason: 'no-openid' };

  // ⚠️ 2026-11-22 硬保护：拒绝非真实 openid。
  //    初版 A 模式传 'bot-self' 导致积分系统里出现假用户（已清）。
  //    真实 QQ openid 是 32 位十六进制；其他形态一律拒绝。
  if (!/^[0-9A-Fa-f]{32}$/.test(openid)) {
    return { ok: false, reason: 'invalid-openid' };
  }

  try {
    const { createPoints } = await pointsMod();
    const pts = cachedPoints ?? createPoints({ dataRoot: pointsRoot(), logger: { warn: () => {} } });
    const amount = POINTS_BY_RARITY.common;

    const before = typeof pts?.balance === 'function' ? pts.balance(openid) : null;
    const r = await pts.refund(openid, amount, '唤醒抽奖', ctx?.name || '');

    // 兼容不同返回形态：有 ok 字段就看 ok，否则看是否有 balance/成功标记
    const ok = r === false ? false : (r && typeof r === 'object' && 'ok' in r ? r.ok !== false : true);
    if (!ok) return { ok: false, reason: 'points-write-failed' };

    const after = r && typeof r === 'object' && Number.isFinite(Number(r.balance))
      ? Number(r.balance)
      : (typeof pts?.balance === 'function' ? pts.balance(openid) : null);

    return {
      ok: true,
      payload: {
        kind: 'points',
        content: { amount, balance: after, before },
      },
    };
  } catch (e) {
    return { ok: false, reason: `points-error:${e instanceof Error ? e.message : String(e)}` };
  }
}

export default { available, run, POINTS_BY_RARITY };
