/**
 * prizes/registry — 出口注册表 + 可用池 + 换奖链（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是本方案**最关键的架构改进**（相对「抽到再降级」）：
 *
 *   ❌ 旧思路：抽到 voice → 语音失败 → 降级成文字
 *            用户：想要语音结果给了文字（体验差）
 *
 *   ✅ 新思路：先问 availableOutlets() 哪些能用 → **只在可用池里抽**
 *            用户：永远拿到真实能兑现的东西
 *
 * 所以 draw() 的第一件事是「用 restrictToAvailable 收窄池子」，
 * 而不是「抽完再换」。
 *
 * 出口统一签名：
 *   available() -> boolean | Promise<boolean>   （可选，缺省视为可用）
 *   run(ctx)    -> { ok:true, payload } | { ok:false, reason }
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { PRIZE_KEYS, RARITY_OF } from '../config.mjs';
import { restrictToAvailable, weightedPick, normalizeWeights } from '../core.mjs';

/** 出口模块相对路径（懒加载，支持热重载）。 */
const MODULES = Object.freeze({
  quote: './quote.mjs',
  image: './image.mjs',
  points: './points.mjs',
  sticker: './sticker.mjs',
  voice: './voice.mjs',
  song: './song.mjs',
  nickname: './nickname.mjs',
  multiplier: './multiplier.mjs',
  secret: './secret.mjs',
});

/** 模块缓存（key = 奖项 key）。 */
const cache = new Map();

/** 懒加载某出口模块。 */
async function loadOutlet(key) {
  if (cache.has(key)) return cache.get(key);
  const rel = MODULES[key];
  if (!rel) return null;
  try {
    const m = await import(rel + `?wl=${Date.now()}`);
    cache.set(key, m);
    return m;
  } catch {
    return null;
  }
}

/** 清缓存（热重载/测试用）。 */
export function clearCache() {
  cache.clear();
}

/**
 * 探测可用出口。
 *
 * **这是「换奖」的根基**：只在返回的池子里抽。
 *
 * @param {{cfg?:object}} [ctx]
 * @returns {Promise<string[]>} 可用奖项 key 列表（至少含 quote）
 */
export async function availableOutlets(ctx) {
  const out = [];
  for (const key of PRIZE_KEYS) {
    const m = await loadOutlet(key);
    if (!m) continue;
    try {
      const av = typeof m.available === 'function' ? await m.available(ctx?.cfg) : true;
      if (av) out.push(key);
    } catch {
      // 探测失败 = 不可用
    }
  }
  // 兜底：quote 永远在（它有内置句）
  if (!out.includes('quote')) out.push('quote');
  return out;
}

/**
 * 抽奖并兑现。
 *
 * 流程：
 *   1. 探测可用池
 *   2. 把权重收窄到可用池
 *   3. 按权重抽
 *   4. 执行出口
 *   5. 失败 → 从剩余可用池重抽（最多 3 次）
 *   6. 全失败 → 强制 quote
 *
 * @param {{gid:string, openid:string, name?:string, cfg:object,
 *          weights:Record<string,number>, random?:()=>number,
 *          timeoutMs?:number, nowMs?:number}} ctx
 * @returns {Promise<{ok:true, prizeKey:string, payload:object, swapped:boolean, swapReason?:string}
 *                 | {ok:false, reason:string}>}
 */
export async function draw(ctx) {
  const rnd = typeof ctx?.random === 'function' ? ctx.random : Math.random;
  const cfg = ctx?.cfg;
  const timeoutMs = Number.isFinite(Number(ctx?.timeoutMs)) ? Number(ctx.timeoutMs) : 8000;

  // 1. 探测可用池（架构核心：只在能用里面抽）
  let pool;
  try {
    pool = await availableOutlets(ctx);
  } catch {
    pool = ['quote'];
  }

  // 2. 收窄权重
  const baseWeights = ctx?.weights && typeof ctx.weights === 'object'
    ? ctx.weights
    : normalizeWeights(cfg?.baseWeights || {}, cfg?.minWeight);

  let weights = restrictToAvailable(baseWeights, pool, cfg?.minWeight);

  const attempts = [];
  let swapped = false;
  let swapReason;

  // 3~6. 抽 + 兑现 + 换奖
  for (let i = 0; i < 3; i += 1) {
    const key = i === 0 ? weightedPick(weights, rnd) : weightedPick(weights, rnd);
    if (attempts.includes(key)) {
      // 同一个已失败过 → 从池里剔除后重算
      const rest = pool.filter((k) => !attempts.includes(k));
      if (rest.length === 0) break;
      weights = restrictToAvailable(baseWeights, rest, cfg?.minWeight);
      continue;
    }
    attempts.push(key);

    const m = await loadOutlet(key);
    if (!m) continue;

    try {
      const r = await m.run({
        ...ctx,
        random: rnd,
        timeoutMs,
        cfg,
      });
      if (r && r.ok) {
        if (i > 0) { swapped = true; swapReason = `${attempts.slice(0, -1).join(',')}-failed`; }
        return { ok: true, prizeKey: key, payload: r.payload, swapped, swapReason };
      }
      // 出口明确失败 → 换奖
      swapped = true;
      swapReason = `${key}:${r?.reason || 'failed'}`;
      const rest = pool.filter((k) => !attempts.includes(k));
      if (rest.length === 0) break;
      weights = restrictToAvailable(baseWeights, rest, cfg?.minWeight);
    } catch {
      swapped = true;
      swapReason = `${key}:threw`;
      const rest = pool.filter((k) => !attempts.includes(k));
      if (rest.length === 0) break;
      weights = restrictToAvailable(baseWeights, rest, cfg?.minWeight);
    }
  }

  // 最后兜底：强制 quote（它永远不该失败）
  try {
    const m = await loadOutlet('quote');
    if (m) {
      const r = await m.run({ ...ctx, random: rnd, timeoutMs, cfg });
      if (r && r.ok) {
        return {
          ok: true,
          prizeKey: 'quote',
          payload: r.payload,
          swapped: true,
          swapReason: swapReason || 'all-failed',
        };
      }
    }
  } catch { /* ignore */ }

  return { ok: false, reason: 'all-outlets-failed' };
}

/** 稀有度查询（上层算保底用）。 */
export function rarityOf(prizeKey) {
  return RARITY_OF[prizeKey] || 'common';
}

export default { availableOutlets, draw, clearCache, rarityOf, MODULES };
