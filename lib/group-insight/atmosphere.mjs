/**
 * atmosphere — 群氛围计算（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纯算法，不用 LLM。四个维度：
 *   ① 活跃度   —— 日均消息数
 *   ② 热闹时段 —— 小时直方图
 *   ③ 情绪基调 —— 情绪词占比（正/负）
 *   ④ 凝聚力   —— 多人同时说话的比例
 *
 * 隐私：输出只含统计值，不含 openid。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { cleanMessages } from './noise-filter.mjs';

/** 正向情绪词。 */
const POS_WORDS = [
  '哈哈', '哈哈哈', '笑死', '笑', '开心', '高兴', '快乐', '喜欢', '爱',
  '太好了', '棒', '赞', '可爱', '谢谢', '耶', '哈哈哈', '乐', '爽',
];

/** 负向情绪词。 */
const NEG_WORDS = [
  '卧槽', '卧槽卧槽', '草', '气死', '烦', '累', '难过', '伤心', '哭',
  '讨厌', '恶心', '无语', '麻了', '累了', '绷不住', '受不了', '死',
];

/** 默认配置。 */
export const ATMO_DEFAULTS = Object.freeze({
  /** 热闹时段的定义：单小时消息数 ≥ 这个值。 */
  busyHourThreshold: 10,
  /** 凝聚力窗口：N 分钟内多人说话算「同时」。 */
  cohesionWindowMs: 5 * 60 * 1000,
});

/**
 * 计算情绪基调（纯函数）。
 *
 * @param {string[]} texts 清洗后的消息文本
 * @returns {{positive:number, negative:number, ratio:number, tone:string}}
 */
export function emotionTone(texts) {
  const list = Array.isArray(texts) ? texts : [];
  let pos = 0, neg = 0;
  for (const t of list) {
    const s = String(t ?? '');
    for (const w of POS_WORDS) if (s.includes(w)) { pos += 1; break; }
    for (const w of NEG_WORDS) if (s.includes(w)) { neg += 1; break; }
  }
  const total = pos + neg;
  const ratio = total > 0 ? pos / total : 0.5;   // 无情绪 → 中性 0.5
  let tone = 'neutral';
  if (total > 0) {
    if (ratio >= 0.65) tone = 'positive';
    else if (ratio <= 0.35) tone = 'negative';
  }
  return { positive: pos, negative: neg, ratio, tone };
}

/**
 * 计算小时直方图（纯函数）。
 *
 * @param {Array<{t?:number}>} messages
 * @returns {Array<{hour:number, count:number}>} 24 项
 */
export function hourlyHistogram(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const hist = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const m of list) {
    const t = Number(m?.t);
    if (!Number.isFinite(t) || t <= 0) continue;
    const hour = new Date(t).getHours();
    if (hour >= 0 && hour < 24) hist[hour].count += 1;
  }
  return hist;
}

/**
 * 找热闹时段（纯函数）。
 *
 * @param {Array<{hour:number, count:number}>} hist
 * @param {number} threshold
 * @returns {Array<number>} 热闹的小时（0-23）
 */
export function busyHours(hist, threshold) {
  const list = Array.isArray(hist) ? hist : [];
  const th = Number(threshold) > 0 ? Number(threshold) : 10;
  return list.filter((h) => h.count >= th).map((h) => h.hour);
}

/**
 * 计算凝聚力：多人同时说话的比例（纯函数）。
 *
 * 定义：5 分钟窗口内 ≥ 3 个不同人发言 = 一次「同时说话」。
 *
 * @param {Array<{s?:string, t?:number}>} messages
 * @param {number} windowMs
 * @returns {{cohesiveBursts:number, ratio:number}}
 */
export function cohesion(messages, windowMs) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.s && Number(m?.t) > 0)
    .sort((a, b) => Number(a.t) - Number(b.t));
  const win = Number(windowMs) > 0 ? Number(windowMs) : 5 * 60 * 1000;
  if (list.length < 3) return { cohesiveBursts: 0, ratio: 0 };

  let bursts = 0;
  let i = 0;
  while (i < list.length) {
    const start = Number(list[i].t);
    const people = new Set();
    let j = i;
    while (j < list.length && Number(list[j].t) - start <= win) {
      people.add(String(list[j].s));
      j += 1;
    }
    if (people.size >= 3) bursts += 1;
    i = j;
  }
  return { cohesiveBursts: bursts, ratio: list.length > 0 ? bursts / list.length : 0 };
}

/**
 * 计算群氛围（主入口，纯函数）。
 *
 * @param {Array<object>} messages 原始消息
 * @param {object} [opts] 覆盖 ATMO_DEFAULTS
 * @returns {object}
 */
export function computeAtmosphere(messages, opts = {}) {
  const cfg = { ...ATMO_DEFAULTS, ...(opts ?? {}) };
  const { clean } = cleanMessages(messages);

  const texts = clean.map((m) => String(m?.x ?? ''));
  const hist = hourlyHistogram(clean);
  const busy = busyHours(hist, cfg.busyHourThreshold);
  const tone = emotionTone(texts);
  const coh = cohesion(clean, cfg.cohesionWindowMs);

  // 活跃度：日均消息数（按消息时间跨度估算天数）
  let days = 1;
  const times = clean.map((m) => Number(m?.t)).filter((t) => t > 0);
  if (times.length >= 2) {
    const span = Math.max(...times) - Math.min(...times);
    days = Math.max(1, Math.round(span / 86400000));
  }

  return {
    totalMsgs: clean.length,
    dailyAvg: Math.round((clean.length / days) * 10) / 10,
    busyHours: busy,
    peakHour: hist.reduce((a, b) => (b.count > a.count ? b : a), hist[0]).hour,
    emotion: tone,
    cohesion: coh,
  };
}

export default { ATMO_DEFAULTS, emotionTone, hourlyHistogram, busyHours, cohesion, computeAtmosphere };
