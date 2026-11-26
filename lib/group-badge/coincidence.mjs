/**
 * group-badge/coincidence — 今日巧合 + 群的小规矩（R7 Stage 5，2026-11-26）
 *
 * 两个东西共用一套「可观测统计」的能力：
 *   · 今日巧合：今天群里意外的共同点（≥3 人撞同一件事）
 *   · 群的小规矩：这个群长期的不成文习惯
 *
 * 全部零 LLM。刻意**不判断语义**，只做关键词共现计数——
 * 因为一旦试图「理解」，就会开始编造。
 */

/** 巧合至少需要几人撞上。 */
export const MIN_PEOPLE = 3;

/** 巧合关键词表（可扩展，但要保守：宁可少报，不可乱报）。 */
export const COINCIDENCE_PATTERNS = Object.freeze([
  { id: 'tired', label: '说累', re: /累|困|疲惫|没精神|好想睡/, text: '今天有 {n} 个人都说累' },
  { id: 'busy', label: '忙', re: /忙|加班|赶|熬夜做/, text: '今天 {n} 个人都在忙' },
  { id: 'hungry', label: '饿', re: /饿|想吃|外卖|干饭/, text: '今天 {n} 个人都在说饿' },
  { id: 'cold', label: '冷', re: /好冷|降温|冻|加衣服/, text: '今天 {n} 个人都觉得冷' },
  { id: 'rain', label: '下雨', re: /下雨|雨下|淋雨|雨伞/, text: '今天 {n} 个人都遇到过雨' },
  { id: 'work', label: '上班', re: /上班|打卡|通勤|工位/, text: '今天 {n} 个人都在上班' },
  { id: 'exam', label: '考试', re: /考试|复习|刷题|期中考|期末/, text: '今天 {n} 个人都在忙学习' },
  { id: 'game', label: '游戏', re: /开黑|上分|游戏|打排位/, text: '今天 {n} 个人都在打游戏' },
]);

/**
 * 检测今日巧合。
 *
 * @param {Array<{s:string, x:string}>} messages 今天的消息
 * @param {{minPeople?:number}} [opts]
 * @returns {Array<{id:string, label:string, people:number, text:string}>}
 */
export function detectCoincidences(messages, opts = {}) {
  const minPeople = Number(opts.minPeople) > 0 ? Number(opts.minPeople) : MIN_PEOPLE;
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.x) : [];
  if (!list.length) return [];

  const out = [];
  for (const p of COINCIDENCE_PATTERNS) {
    // 按**人去重**：同一个人说三次「累」不算三个人
    const who = new Set();
    for (const m of list) {
      if (p.re.test(String(m.x))) {
        const id = String(m.s ?? '');
        if (id) who.add(id);
      }
    }
    if (who.size >= minPeople) {
      out.push({
        id: p.id,
        label: p.label,
        people: who.size,
        text: p.text.replace('{n}', String(who.size)),
      });
    }
  }
  return out;
}

/** 星期名。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 统计群的小规矩（长期习惯）。
 *
 * @param {Array<{t:number, x:string, s:string}>} messages 历史消息
 * @param {{minSamples?:number}} [opts]
 * @returns {Array<{id:string, text:string}>}
 */
export function detectCustoms(messages, opts = {}) {
  const minSamples = Number(opts.minSamples) > 0 ? Number(opts.minSamples) : 100;
  const list = Array.isArray(messages) ? messages.filter((m) => m && Number.isFinite(Number(m.t))) : [];
  if (list.length < minSamples) return [];

  const out = [];
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  let imageAfterReply = 0;
  let imageCount = 0;

  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    const d = new Date(Number(m.t));
    byHour[d.getHours()] += 1;
    byWeekday[d.getDay()] += 1;

    // 图片消息后是否有人接话（用「有 x 但无明显正文」近似图片）
    const text = String(m.x ?? '');
    const isImageLike = text.length < 8 && /\[图|图片|image|\.jpg|\.png/i.test(text);
    if (isImageLike) {
      imageCount += 1;
      const next = list[i + 1];
      if (next && String(next.s) !== String(m.s)) imageAfterReply += 1;
    }
  }

  const total = list.length;

  // ① 深夜活跃
  const night = byHour[0] + byHour[1] + byHour[2] + byHour[3];
  if (night / total >= 0.2) {
    out.push({ id: 'active-at-night', text: '你们群深夜才是主场' });
  }

  // ② 白天安静
  const day = byHour[9] + byHour[10] + byHour[11] + byHour[13] + byHour[14] + byHour[15];
  if (day / total < 0.1) {
    out.push({ id: 'quiet-at-day', text: '白天基本没人说话' });
  }

  // ③ 某天特别热闹
  let maxDay = 0;
  let maxDayIdx = -1;
  for (let i = 0; i < 7; i += 1) {
    if (byWeekday[i] > maxDay) { maxDay = byWeekday[i]; maxDayIdx = i; }
  }
  if (maxDayIdx >= 0 && maxDay / total >= 0.25) {
    out.push({ id: 'peak-weekday', text: `${WEEKDAYS[maxDayIdx]}聊得最多` });
  }

  // ④ 发图就有人接
  if (imageCount >= 5 && imageAfterReply / imageCount >= 0.5) {
    out.push({ id: 'image-echo', text: '每次有人发图就会有人接' });
  }

  return out;
}

/**
 * 时间机器：从长期存档取「同一天」的历史消息。
 *
 * 纯函数：调用方负责读文件，这里只做筛选。
 *
 * @param {Array<{t:number, x:string, n?:string}>} archived 历史消息
 * @param {{month:number, day:number, excludeYear?:number}} target
 * @returns {Array<object>} 匹配的消息（可能跨多年）
 */
export function pickSameDay(archived, target = {}) {
  const list = Array.isArray(archived) ? archived : [];
  const month = Number(target.month);
  const day = Number(target.day);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return [];

  const excludeYear = Number(target.excludeYear);
  return list.filter((m) => {
    const t = Number(m?.t);
    if (!Number.isFinite(t)) return false;
    const d = new Date(t);
    if (d.getMonth() + 1 !== month || d.getDate() !== day) return false;
    if (Number.isFinite(excludeYear) && d.getFullYear() === excludeYear) return false;
    return true;
  });
}

export default {
  MIN_PEOPLE, COINCIDENCE_PATTERNS,
  detectCoincidences, detectCustoms, pickSameDay,
};
