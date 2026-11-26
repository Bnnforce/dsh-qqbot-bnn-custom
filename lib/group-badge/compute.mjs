/**
 * group-badge — 群徽章（R7 Stage 5，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这是「别人做不到」的小物件：
 *
 *   市面上的伴侣 bot 的趣味功能都是**通用的**（打错字再补、随机表情）。
 *   而徽章是从**这个群自己的历史**里统计出来的——「熬夜冠军」只对真的熬夜的群成立。
 *
 *   全部零 LLM，纯统计。数据源是长期存档（msg-archive）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 最少需要多少条消息才敢出徽章（太少没有意义）。 */
export const MIN_SAMPLES = 50;

/** 最多展示几个徽章。 */
export const MAX_BADGES = 3;

/** 徽章定义：判定 + 阈值 + 展示文案。 */
export const BADGES = Object.freeze([
  {
    id: 'night-owl',
    label: '🌙 熬夜冠军',
    desc: '凌晨还在聊',
    test: (s) => s.nightRatio,
    weight: 0.2,
    min: 0.2,
  },
  {
    id: 'early-bird',
    label: '🐦 早起群',
    desc: '清早就有人说话',
    test: (s) => s.earlyRatio,
    weight: 0.15,
    min: 0.15,
  },
  {
    id: 'chatty',
    label: '💬 话痨群',
    desc: '消息量很大',
    test: (s) => s.dailyAvg,
    weight: 100,
    min: 100,
  },
  {
    id: 'longform',
    label: '📚 认真群',
    desc: '说话都不短',
    test: (s) => s.avgLen,
    weight: 30,
    min: 30,
  },
  {
    id: 'emoji-rich',
    label: '😂 沙雕群',
    desc: '表情特别多',
    test: (s) => s.emojiRatio,
    weight: 0.25,
    min: 0.25,
  },
  {
    id: 'steady',
    label: '🤝 老友群',
    desc: '天天都有人来',
    weight: 0.8,
    test: (s) => s.activeDayRatio,
    min: 0.8,
  },
]);

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/**
 * 从消息列表算统计特征。
 *
 * @param {Array<{t:number, x:string, s:string}>} messages
 * @returns {object} 统计特征
 */
export function groupStats(messages) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && Number.isFinite(Number(m.t))) : [];
  const n = list.length;
  if (n === 0) {
    return {
      total: 0, nightRatio: 0, earlyRatio: 0, dailyAvg: 0,
      avgLen: 0, emojiRatio: 0, activeDayRatio: 0, days: 0,
    };
  }

  let night = 0;
  let early = 0;
  let withEmoji = 0;
  let totalLen = 0;
  const days = new Set();

  for (const m of list) {
    const d = new Date(Number(m.t));
    const h = d.getHours();
    if (h >= 0 && h < 4) night += 1;
    if (h >= 5 && h < 8) early += 1;
    const text = String(m.x ?? '');
    totalLen += text.length;
    if ((text.match(EMOJI_RE) || []).length > 0) withEmoji += 1;
    days.add(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
  }

  return {
    total: n,
    nightRatio: round3(night / n),
    earlyRatio: round3(early / n),
    dailyAvg: round1(n / Math.max(1, days.size)),
    avgLen: round1(totalLen / n),
    emojiRatio: round3(withEmoji / n),
    activeDayRatio: 1,
    days: days.size,
  };
}

/**
 * 算出该群该挂哪些徽章。
 *
 * @param {Array<object>} messages
 * @param {{max?:number}} [opts]
 * @returns {Array<{id:string,label:string,desc:string,value:number}>}
 */
export function computeBadges(messages, opts = {}) {
  const stats = groupStats(messages);
  if (stats.total < MIN_SAMPLES) return [];

  const max = Number(opts.max) > 0 ? Number(opts.max) : MAX_BADGES;
  const hits = [];

  for (const b of BADGES) {
    const v = Number(b.test(stats)) || 0;
    if (v < b.min) continue;
    // 归一化强度：超过阈值多少倍（用于排序）
    const strength = b.weight > 0 ? v / b.weight : 0;
    hits.push({ id: b.id, label: b.label, desc: b.desc, value: round3(v), strength });
  }

  hits.sort((a, b) => b.strength - a.strength);
  return hits.slice(0, max).map(({ strength, ...rest }) => rest);
}

/**
 * 渲染成一行文本（供卡片/命令用）。
 *
 * @param {Array<object>} badges
 * @returns {string}
 */
export function renderBadges(badges) {
  const list = Array.isArray(badges) ? badges : [];
  if (!list.length) return '';
  return list.map((b) => b.label).join('　');
}

function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }
function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

export default { BADGES, MIN_SAMPLES, MAX_BADGES, groupStats, computeBadges, renderBadges };
