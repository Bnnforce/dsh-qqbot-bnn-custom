/**
 * persona-evolution/metrics — 人格演化指标（R7 Stage 4，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与市面项目的根本差异：
 *
 *   学界（如 Persona Drift Detection 论文）做的是「**防漂移**」——
 *   检测到人格偏移就纠正，目标是「保持一致」。
 *
 *   我们做的是「**有控制的成长**」——
 *   记录她怎么变的，**只读呈现**，改不改由主人决定。
 *
 *   方向相反，但都不动角色卡。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 三个可量化维度（全从出站消息算，零 LLM）：
 *   · 说话方式：句长、提问率、表情率
 *   · 情绪基线：均值、波动幅度
 *   · 社交主动：主动次数、回复延迟
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 表情符号粗判（够用即可，不追求完整 Unicode 表情表）。 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/** 提问标记。 */
const QUESTION_RE = /[?？]/;

/**
 * 从一条出站消息算基础指标。
 *
 * @param {string} text
 * @returns {{len:number, isQuestion:boolean, emojiCount:number}}
 */
export function analyzeMessage(text) {
  const t = String(text ?? '');
  const emojis = t.match(EMOJI_RE) || [];
  return {
    len: t.length,
    isQuestion: QUESTION_RE.test(t),
    emojiCount: emojis.length,
  };
}

/**
 * 汇总一批消息的「说话方式」指标。
 *
 * @param {Array<{text:string}>} messages
 * @returns {{avgLen:number, questionRate:number, emojiRate:number, samples:number}}
 */
export function styleMetrics(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const valid = list.map((m) => analyzeMessage(m?.text ?? m)).filter((x) => x.len > 0);
  const n = valid.length;
  if (n === 0) return { avgLen: 0, questionRate: 0, emojiRate: 0, samples: 0 };

  let totalLen = 0;
  let questions = 0;
  let withEmoji = 0;
  for (const v of valid) {
    totalLen += v.len;
    if (v.isQuestion) questions += 1;
    if (v.emojiCount > 0) withEmoji += 1;
  }
  return {
    avgLen: round2(totalLen / n),
    questionRate: round3(questions / n),
    emojiRate: round3(withEmoji / n),
    samples: n,
  };
}

/**
 * 从情绪历史快照算「情绪基线」。
 *
 * @param {Array<object>} snapshots 每日快照数组（每项含 8 维数值）
 * @param {string[]} [axes] 要统计的维度名
 * @returns {{moodAvg:number, energyAvg:number, variance:number, samples:number}}
 */
export function moodMetrics(snapshots, axes = []) {
  const list = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s && typeof s === 'object');
  const n = list.length;
  if (n === 0) return { moodAvg: 0, energyAvg: 0, variance: 0, samples: 0 };

  // 优先用 mood / energy 两个主维；没有就取所有数值字段的均值
  const pick = (key) => {
    const vals = list.map((s) => Number(s?.[key])).filter((v) => Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  const moodAvg = pick('mood');
  const energyAvg = pick('energy');

  // 波动幅度：mood 减去均值后的平均绝对偏差
  const moodVals = list.map((s) => Number(s?.mood)).filter((v) => Number.isFinite(v));
  let variance = 0;
  if (moodVals.length > 1) {
    const mean = moodVals.reduce((a, b) => a + b, 0) / moodVals.length;
    variance = moodVals.reduce((a, b) => a + Math.abs(b - mean), 0) / moodVals.length;
  }

  return {
    moodAvg: round3(moodAvg),
    energyAvg: round3(energyAvg),
    variance: round3(variance),
    samples: n,
  };
}

/**
 * 算两个时期的变化量。
 *
 * @param {object} first 早期指标
 * @param {object} last 近期指标
 * @returns {{avgLen:number, questionRate:number, emojiRate:number, moodAvg:number, variance:number}}
 */
export function deltaOf(first = {}, last = {}) {
  const d = (a, b) => round3((Number(b) || 0) - (Number(a) || 0));
  return {
    avgLen: d(first?.style?.avgLen, last?.style?.avgLen),
    questionRate: d(first?.style?.questionRate, last?.style?.questionRate),
    emojiRate: d(first?.style?.emojiRate, last?.style?.emojiRate),
    moodAvg: d(first?.mood?.moodAvg, last?.mood?.moodAvg),
    variance: d(first?.mood?.variance, last?.mood?.variance),
  };
}

/** 变化是否显著（超过阈值才值得调 LLM 生成叙事）。 */
export const SIGNIFICANT = Object.freeze({
  avgLen: 3,
  questionRate: 0.05,
  emojiRate: 0.05,
  moodAvg: 0.05,
  variance: 0.03,
});

/**
 * 判断变化是否显著。
 *
 * @param {object} delta
 * @returns {boolean}
 */
export function isSignificant(delta = {}) {
  for (const [k, threshold] of Object.entries(SIGNIFICANT)) {
    if (Math.abs(Number(delta?.[k]) || 0) > threshold) return true;
  }
  return false;
}

/**
 * 从出站消息记录里提取「社交主动」指标。
 *
 * @param {Array<{self?:boolean, text?:string}>} messages
 * @returns {{proactiveCount:number, replyCount:number, samples:number}}
 */
export function socialMetrics(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const self = list.filter((m) => m?.self === true);
  return {
    proactiveCount: self.length,
    replyCount: list.length - self.length,
    samples: list.length,
  };
}

/**
 * 里程碑检测（规则化，不靠 LLM）。
 *
 * @param {Array<object>} metricsList 历次指标
 * @param {object} [ctx] 额外上下文（如 hasDiary / startAt）
 * @returns {string[]} 命中的里程碑 id
 */
export function detectMilestones(metricsList = [], ctx = {}) {
  const list = Array.isArray(metricsList) ? metricsList : [];
  const hits = [];
  const has = (id) => hits.includes(id);

  const totalProactive = list.reduce((a, m) => a + (Number(m?.social?.proactiveCount) || 0), 0);
  const totalReplies = list.reduce((a, m) => a + (Number(m?.social?.replyCount) || 0), 0);

  if (totalProactive > 0 && !has('first-proactive')) hits.push('first-proactive');
  if (totalReplies >= 100 && !has('100-replies')) hits.push('100-replies');
  if (ctx?.hasDiary === true && !has('first-diary')) hits.push('first-diary');

  const startAt = Number(ctx?.startAt) || 0;
  if (startAt > 0 && Date.now() - startAt >= 30 * 24 * 60 * 60 * 1000) {
    hits.push('30-days');
  }
  return hits;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

export default {
  analyzeMessage, styleMetrics, moodMetrics, deltaOf,
  isSignificant, socialMetrics, detectMilestones, SIGNIFICANT,
};
