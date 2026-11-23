/**
 * wake-lottery/core — 判定 / 权重 / 保底 / A-B 模式（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纪律（与 heartbeat.js、mood-axis.js 同款，改之前先读）
 *
 *   ① **纯函数**：不读盘、不取随机数、不抛错。
 *      随机数由调用方注入（可测）；时钟由调用方传 nowMs。
 *   ② **不修改入参**：所有导出返回新对象。
 *   ③ **reason 是稳定字符串**：可用于日志与测试断言，改了就是契约变更。
 *   ④ 前置判定**顺序固定**，任一命中即返回（对齐心跳状态机的写法）。
 *
 * 这个文件是整个功能的大脑，但没有一行 IO —— 所以能 100% 单测。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { PRIZE_KEYS, RARITY_OF, DEFAULT_CONFIG } from './config.mjs';

/* ──────────────────────────────────────────────────────────────
 * 一、时间与装死窗
 * ────────────────────────────────────────────────────────────── */

/** 从毫秒时间戳取「某时区的小时数」。 */
export function hourOf(nowMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || DEFAULT_CONFIG.timezone,
      hour: 'numeric',
      hour12: false,
    });
    const h = Number(fmt.format(new Date(nowMs)));
    return Number.isFinite(h) ? h % 24 : 0;
  } catch {
    // 时区非法 → 退化为 UTC 小时（不抛）
    return new Date(nowMs).getUTCHours();
  }
}

/** 从毫秒时间戳取 YYYY-MM-DD（某时区）。 */
export function dateKeyOf(nowMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || DEFAULT_CONFIG.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/**
 * 是否在装死窗内（左闭右开）。
 *
 * 支持跨零点：start=22, end=6 → [22,24) ∪ [0,6)
 *
 * @param {number} nowMs
 * @param {{start:number,end:number}} win
 * @param {string} timezone
 * @returns {boolean}
 */
export function inSleepWindow(nowMs, win, timezone) {
  const scale = win && typeof win === 'object' ? win : DEFAULT_CONFIG.sleepWindow;
  const start = Number(scale.start);
  const end = Number(scale.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const h = hourOf(nowMs, timezone);
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  // 跨零点
  return h >= start || h < end;
}

/* ──────────────────────────────────────────────────────────────
 * 二、前置判定（10 条，顺序固定）
 * ────────────────────────────────────────────────────────────── */

/** 判定结果：通过。 */
const READY = Object.freeze({ yes: true, reason: 'ready' });

/** 判定结果：不通过。 */
function no(reason) {
  return { yes: false, reason };
}

/** 时钟回拨容差：lastAt 最多可以比 now 大 5 分钟。 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * 该不该触发唤醒抽奖。
 *
 * **10 条前置，顺序固定**，任一命中即返回：
 *   1. disabled          总开关
 *   2. sleep-window      装死窗
 *   3. clock-skew        时钟回拨
 *   4. dead-group        死群
 *   5. not-cold          不是 cold
 *   6. cold-too-short    cold 太短
 *   7. heartbeat-waiting 心跳正要说话
 *   8. global-cap        全局小时上限
 *   9. group-cooldown    同群冷却
 *  10. daily-cap         每群每日上限
 *
 * @param {{
 *   heartbeat: object|null,
 *   lastLottery: object|null,
 *   globalStats: object|null,
 *   nowMs: number
 * }} input
 * @param {typeof DEFAULT_CONFIG} cfg
 * @param {number} [nowMs]
 * @returns {{yes:boolean, reason:string}}
 */
export function shouldStart(input, cfg, nowMs) {
  const c = cfg || DEFAULT_CONFIG;
  const now = Number.isFinite(nowMs) ? nowMs : Number(input?.nowMs);
  const safeNow = Number.isFinite(now) ? now : Date.now();

  // 1. 总开关
  if (!c.enabled) return no('disabled');

  // 2. 装死窗
  if (inSleepWindow(safeNow, c.sleepWindow, c.timezone)) return no('sleep-window');

  const hb = input?.heartbeat;
  const last = input?.lastLottery;

  // 3. 时钟回拨（lastAt 在未来太多）
  if (last && Number.isFinite(last.lastAt) && last.lastAt > safeNow + CLOCK_SKEW_TOLERANCE_MS) {
    return no('clock-skew');
  }

  // 4. 死群
  if (hb) {
    const lastHuman = Number(hb.lastNonBotMessageAt);
    if (Number.isFinite(lastHuman) && lastHuman > 0) {
      if (safeNow - lastHuman > c.deadGroupMs) return no('dead-group');
    }
  }

  // 5. 不是 cold
  if (!hb || hb.cold !== true) return no('not-cold');

  // 6. cold 太短
  const coldSetAt = Number(hb.coldSetAt);
  if (!Number.isFinite(coldSetAt) || coldSetAt <= 0) return no('cold-too-short');
  if (safeNow - coldSetAt < c.coldMinMs) return no('cold-too-short');

  // 7. 心跳正要说话
  if (hb.state === 'waiting') return no('heartbeat-waiting');

  // 8. 全局小时上限
  const global = input?.globalStats;
  if (global && Number.isFinite(global.hourlyCount) && global.hourlyCount >= c.globalHourlyCap) {
    return no('global-cap');
  }

  // 9. 同群冷却
  if (last && Number.isFinite(last.lastAt) && last.lastAt > 0) {
    if (safeNow - last.lastAt < c.perGroupCooldownMs) return no('group-cooldown');
  }

  // 10. 每群每日上限
  if (last) {
    const today = dateKeyOf(safeNow, c.timezone);
    const sameDay = last.dateKey === today;
    const count = sameDay && Number.isFinite(last.dailyCount) ? last.dailyCount : 0;
    if (count >= c.perGroupDailyCap) return no('daily-cap');
  }

  return { ...READY };
}

/* ──────────────────────────────────────────────────────────────
 * 三、权重：归一化 + 八维调整 + 保底提权
 * ────────────────────────────────────────────────────────────── */

/** 中性情绪值（读不到八维时用）。 */
export const NEUTRAL_DIM = 0.5;

/**
 * 把任意权重表归一化到 sum === 100，且每项可达 minWeight。
 *
 * **保证**：返回的每项都 >= 0，sum 恰好 100，不修改入参。
 *
 * @param {Record<string, number>} weights
 * @param {number} [minWeight]
 * @returns {Record<string, number>}
 */
export function normalizeWeights(weights, minWeight) {
  const mw = Number.isFinite(minWeight) && minWeight > 0 ? minWeight : 0;
  const src = weights && typeof weights === 'object' ? weights : {};

  // 1. 收集已知奖项，非法值当 0
  const vals = {};
  let sum = 0;
  for (const key of PRIZE_KEYS) {
    const v = Number(src[key]);
    const safe = Number.isFinite(v) && v > 0 ? v : 0;
    vals[key] = safe;
    sum += safe;
  }

  // 2. 全 0 → 均分（保证永远可抽）
  if (sum <= 0) {
    const each = 100 / PRIZE_KEYS.length;
    const out = {};
    for (const key of PRIZE_KEYS) out[key] = each;
    return out;
  }

  // 3. 抬到 minWeight（只针对原本 > 0 的，避免复活已被排除的奖项）
  if (mw > 0) {
    for (const key of PRIZE_KEYS) {
      if (vals[key] > 0 && vals[key] < mw) {
        sum += mw - vals[key];
        vals[key] = mw;
      }
    }
  }

  // 4. 归一化到 100
  const out = {};
  for (const key of PRIZE_KEYS) out[key] = (vals[key] / sum) * 100;
  return out;
}

/**
 * 根据八维情绪调整权重。
 *
 * 调整矩阵（最终方案 §四）：
 *   energy < 0.35   → voice/song ↓50%，quote ↑60%
 *   energy > 0.7    → voice/song ↑30%
 *   connection > 0.65 → quote ↑40%
 *   connection < 0.35 → image ↑30%，sticker ↑40%
 *   mood < 0.35     → image ↑30%，song ↑20%，secret ↓50%
 *   mood > 0.7      → secret ↑50%，nickname ↑50%
 *   closeness > 0.7 → voice ↑50%，nickname ↑30%
 *   composure < 0.3 → 稀有奖项 ↓50%
 *
 * 然后按 pityCounter 提权：达到阈值时稀有奖项 ×2。
 *
 * @param {object|null} dims  八维；null → 不调整
 * @param {typeof DEFAULT_CONFIG} cfg
 * @param {number} [pityCounter]
 * @returns {Record<string, number>} 归一化后的权重（sum === 100）
 */
export function adjustWeights(dims, cfg, pityCounter) {
  const c = cfg || DEFAULT_CONFIG;
  const base = { ...c.baseWeights };
  const tuning = c.dimensionTuning !== false;
  const d = dims && typeof dims === 'object' ? dims : null;
  const valid = tuning && d && isDimsUsable(d);

  const w = { ...base };

  if (valid) {
    const num = (k) => (Number.isFinite(Number(d[k])) ? Number(d[k]) : NEUTRAL_DIM);
    const energy = num('energy');
    const connection = num('connection');
    const mood = num('mood');
    const closeness = num('closeness');
    const composure = num('composure');

    if (energy < 0.35) { w.voice *= 0.5; w.song *= 0.5; w.quote *= 1.6; }
    else if (energy > 0.7) { w.voice *= 1.3; w.song *= 1.3; }

    if (connection > 0.65) { w.quote *= 1.4; }
    else if (connection < 0.35) { w.image *= 1.3; w.sticker *= 1.4; }

    if (mood < 0.35) { w.image *= 1.3; w.song *= 1.2; w.secret *= 0.5; }
    else if (mood > 0.7) { w.secret *= 1.5; w.nickname *= 1.5; }

    if (closeness > 0.7) { w.voice *= 1.5; w.nickname *= 1.3; }

    if (composure < 0.3) { w.nickname *= 0.5; w.multiplier *= 0.5; w.secret *= 0.5; }
  }

  // 保底：连续未中稀有达到阈值 → 稀有奖项 ×2
  const pity = Number(pityCounter);
  const threshold = Number.isFinite(c.pityThreshold) ? c.pityThreshold : DEFAULT_CONFIG.pityThreshold;
  if (Number.isFinite(pity) && pity >= threshold) {
    for (const key of Object.keys(RARITY_OF)) {
      const r = RARITY_OF[key];
      if (r === 'rare' || r === 'legendary') w[key] *= 2;
    }
  }

  return normalizeWeights(w, c.minWeight);
}

/** 八维是否可用（全部可解析为 0..1）。 */
function isDimsUsable(d) {
  let ok = 0;
  for (const k of ['mood', 'energy', 'connection', 'composure', 'closeness', 'patience', 'confidence', 'focus']) {
    const v = Number(d[k]);
    if (Number.isFinite(v) && v >= 0 && v <= 1) ok += 1;
  }
  return ok >= 4; // 至少一半维度有效
}

/* ──────────────────────────────────────────────────────────────
 * 四、抽签
 * ────────────────────────────────────────────────────────────── */

/**
 * 按权重抽一个奖项。
 *
 * @param {Record<string,number>} weights  sum 不必恰好 100（内部按实际和算）
 * @param {() => number} [random]          注入以便测试
 * @returns {string} 奖项 key
 */
export function weightedPick(weights, random) {
  const rnd = typeof random === 'function' ? random : Math.random;
  const src = weights && typeof weights === 'object' ? weights : {};

  let total = 0;
  for (const key of PRIZE_KEYS) {
    const v = Number(src[key]);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  // 全 0 → 兜底一句话
  if (total <= 0) return 'quote';

  let r = rnd() * total;
  for (const key of PRIZE_KEYS) {
    const v = Number(src[key]);
    if (!Number.isFinite(v) || v <= 0) continue;
    r -= v;
    if (r <= 0) return key;
  }
  // 浮点误差兜底：返回最后一个权重 > 0 的
  for (let i = PRIZE_KEYS.length - 1; i >= 0; i -= 1) {
    const v = Number(src[PRIZE_KEYS[i]]);
    if (Number.isFinite(v) && v > 0) return PRIZE_KEYS[i];
  }
  return 'quote';
}

/**
 * 保底计数推进。
 *
 * @param {string} prizeKey 本次抽中的奖项
 * @param {number} pityCounter 之前的计数
 * @param {typeof DEFAULT_CONFIG} cfg
 * @returns {{pity:number, forced:boolean}}
 */
export function applyPity(prizeKey, pityCounter, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const rarity = RARITY_OF[prizeKey] || 'common';
  const isRare = rarity === 'rare' || rarity === 'legendary';

  if (isRare) return { pity: 0, forced: false };

  const prev = Number.isFinite(Number(pityCounter)) ? Math.max(0, Math.round(Number(pityCounter))) : 0;
  const next = prev + 1;
  const threshold = Number.isFinite(c.pityThreshold) ? c.pityThreshold : DEFAULT_CONFIG.pityThreshold;

  if (next >= threshold) {
    // 达到阈值：清零（下次 adjustWeights 会提权），标记 forced
    return { pity: 0, forced: true };
  }
  return { pity: next, forced: false };
}

/* ──────────────────────────────────────────────────────────────
 * 五、A/B 模式与 cycleId
 * ────────────────────────────────────────────────────────────── */

/**
 * 选模式：'self'（她自抽）还是 'invite'（邀请群友）。
 *
 * @param {typeof DEFAULT_CONFIG} cfg
 * @param {() => number} [random]
 * @returns {'self'|'invite'}
 */
export function pickMode(cfg, random) {
  const c = cfg || DEFAULT_CONFIG;
  const rnd = typeof random === 'function' ? random : Math.random;
  const ratio = Number.isFinite(Number(c.selfDrawRatio)) ? Math.min(1, Math.max(0, Number(c.selfDrawRatio))) : 0.5;
  return rnd() < ratio ? 'self' : 'invite';
}

/**
 * 生成 cycleId：同一小时同一群唯一。
 *
 * 用途：防 A/B 双触发、防过期卡片被点。
 *
 * @param {number} nowMs
 * @param {string} gid
 * @param {string} [timezone]
 * @returns {string} 形如 '20261122-688E38-20'
 */
export function makeCycleId(nowMs, gid, timezone) {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const date = dateKeyOf(safeNow, timezone).replace(/-/g, '');
  const h = String(hourOf(safeNow, timezone)).padStart(2, '0');
  const g = String(gid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'nogid';
  return `${date}-${g}-${h}`;
}

/* ──────────────────────────────────────────────────────────────
 * 六、可抽池过滤
 * ────────────────────────────────────────────────────────────── */

/**
 * 把权重表裁剪到「当前可用出口」范围内，并重新归一化。
 *
 * 这是本方案的核心改进（相对「抽到再降级」）：
 * **只在可用池里抽**，用户永远拿到真实能兑现的奖项。
 *
 * @param {Record<string,number>} weights
 * @param {string[]} available  可用奖项 key 列表
 * @param {number} [minWeight]
 * @returns {Record<string,number>}
 */
export function restrictToAvailable(weights, available, minWeight) {
  const pool = Array.isArray(available) ? new Set(available) : null;
  const src = weights && typeof weights === 'object' ? weights : {};
  const out = {};

  for (const key of PRIZE_KEYS) {
    const v = Number(src[key]);
    const usable = Number.isFinite(v) && v > 0 && (!pool || pool.has(key));
    out[key] = usable ? v : 0;
  }

  const sum = PRIZE_KEYS.reduce((a, k) => a + out[k], 0);
  // 可用池为空 → 兜底一句话
  if (sum <= 0) {
    const fallback = {};
    for (const key of PRIZE_KEYS) fallback[key] = key === 'quote' ? 1 : 0;
    return fallback;
  }
  return normalizeWeights(out, 0);
}

export default {
  hourOf, dateKeyOf, inSleepWindow,
  shouldStart, normalizeWeights, adjustWeights, weightedPick, applyPity,
  pickMode, makeCycleId, restrictToAvailable, NEUTRAL_DIM,
};
