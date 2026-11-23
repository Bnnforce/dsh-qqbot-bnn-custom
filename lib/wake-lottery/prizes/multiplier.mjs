/**
 * prizes/multiplier — 加倍券（R5.6）
 *
 * 抽到一张券，下次积分翻倍。存进状态文件。
 *
 * 规则（最终方案 §5.3 R27）：
 *   · 最多存 maxMultiplierCoupons 张（默认 3）
 *   · 有期限（默认 7 天）
 *   · 超上限 → 不增发，改为给积分（返回 ok:false 让上层换奖）
 */
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic, rootDir, diag } from '../store.mjs';
import { DEFAULT_CONFIG } from '../config.mjs';

/** 券有效期（7 天）。 */
const COUPON_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 券文件。 */
function couponFile(gid) {
  const s = String(gid ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
  return join(rootDir(), `_coupons-${s}.json`);
}

/** 读某群的券列表（过期自动过滤）。 */
export function readCoupons(gid, nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const raw = readJsonSafe(couponFile(gid));
  if (!raw || !Array.isArray(raw.coupons)) return [];
  return raw.coupons.filter((c) => {
    const exp = Number(c?.expiresAt);
    return Number.isFinite(exp) && exp > now;
  });
}

export function available() {
  return true;
}

/**
 * 抽一张加倍券。
 *
 * @param {{gid:string, nowMs?:number, cfg?:object}} ctx
 */
export async function run(ctx) {
  try {
    const gid = String(ctx?.gid ?? '').trim();
    if (!gid) return { ok: false, reason: 'no-gid' };

    const cfg = ctx?.cfg || DEFAULT_CONFIG;
    const max = Number.isFinite(Number(cfg.maxMultiplierCoupons)) ? Number(cfg.maxMultiplierCoupons) : 3;
    const now = Number.isFinite(Number(ctx?.nowMs)) ? Number(ctx.nowMs) : Date.now();

    const coupons = readCoupons(gid, now);
    if (coupons.length >= max) {
      // 到上限 → 不增发，让上层换奖（R27）
      return { ok: false, reason: 'coupon-cap' };
    }

    const next = [...coupons, { expiresAt: now + COUPON_TTL_MS, createdAt: now }];
    const ok = writeJsonAtomic(couponFile(gid), { coupons: next, updatedAt: now });
    if (!ok) { diag(`[加倍券] gid=${gid} 写失败`); return { ok: false, reason: 'coupon-write-failed' }; }

    return {
      ok: true,
      payload: {
        kind: 'text',
        content: `捡到一张加倍券。下次拿到积分翻倍。\n\n（手上 ${next.length} 张）`,
      },
    };
  } catch (e) {
    return { ok: false, reason: `coupon-error:${e instanceof Error ? e.message : String(e)}` };
  }
}

export default { available, readCoupons, run };
