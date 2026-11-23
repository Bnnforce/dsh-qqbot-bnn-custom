/**
 * memoir/stats — 群聊结构化统计（R5.5 群回忆录）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块
 *
 * 回忆录要「说人话」，但不能瞎编 —— 得先有**可核对的事实**：
 *   这周多少条、谁最活跃、几点最热闹、都在聊什么。
 *
 * 本模块把清洗后的消息变成结构化 stats，供两类消费者用：
 *   ① narrate 的 A 形态（纯模板填空，零 LLM）
 *   ② narrate 的 B 形态（喂给 LLM 做叙事，不喂原始消息 ⇒ 省 token + 防隐私泄漏）
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────
 *   ① **纯函数、零 IO** —— 输入清洗后消息，输出 stats，不读盘不写盘
 *   ② **空输入不抛** —— 全 0 结构，调用方无需 try-catch
 *   ③ **关键词不引第三方分词库** —— 用字符 n-gram，配合停用词过滤
 *      （实测：不清洗时 100% 是噪声；清洗后 n-gram 够用，且零依赖利于开源）
 *
 * ── 实测依据 ────────────────────────────────────────────────────────────
 *   示例群 8 天 1748 条 → 群友 1200 条
 *   最活跃 21点(187) / 22点(153) / 23点(142)
 *   发言 TOP: 群友A 751 / 群友B 87 / 群友C 67
 *
 * ── 改动前先读 ──────────────────────────────────────────────────────────
 *   · R5.5 接口契约.md §② stats.mjs
 *   · memoir/clean.mjs（输入格式由它决定）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { COMMON_WORDS } from '../slang/config.mjs';

/** 关键词最小频次（低于这个不算话题）。 */
const KEYWORD_MIN_COUNT = 3;

/** 关键词长度范围（中文 2~3 字）。 */
const CN_WORD_RE = /[\u4e00-\u9fa5]{2,3}/gu;

/**
 * 提取中文 n-gram 词频。
 *
 * @param {string[]} texts
 * @param {{ excludeNames?: Set<string> }} [opts] 要排除的词（通常是昵称）
 * @returns {Map<string, number>}
 */
function countNgrams(texts, opts = {}) {
  const exclude = opts.excludeNames instanceof Set ? opts.excludeNames : new Set();
  const freq = new Map();
  for (const t of texts) {
    const hits = String(t ?? '').match(CN_WORD_RE) || [];
    for (const w of hits) {
      if (COMMON_WORDS.has(w)) continue;   // 日常词
      if (exclude.has(w)) continue;        // 昵称 / 人名片段
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return freq;
}

/**
 * 统计清洗后的群聊消息。
 *
 * @param {Array<{text:string, n:string, t:number}>} rows cleanRows() 的输出
 * @param {{ topPeople?:number, topKeywords?:number, tz?:string }} [opts]
 * @returns {{
 *   total:number, people:number,
 *   topPeople:Array<{name:string,count:number}>,
 *   hours:number[], peakHour:number,
 *   keywords:Array<{word:string,count:number}>,
 *   days:number
 * }}
 */
/**
 * n-gram 滑窗的固有缺陷：会切出跨界碎片（「火锅真」「火锅太」），
 * 而真正的词「火锅」因为被切开而分散计数，反而进不了 TOP。
 *
 * 修正思路（测试驱动出来的）：对每个 3 字 n-gram，如果它的某个 2 字子串
 * 频次 **不低于** 自身，说明这个 3 字串是跨界碎片 ⇒ 把计数并入子串、自身减半。
 *
 * @param {Map<string, number>} freq 就地修改
 */
function liftSubstrings(freq) {
  const entries = [...freq.entries()].filter(([w]) => w.length > 2);
  for (const [w, c] of entries) {
    let bestSub = '';
    let bestSubCount = 0;
    for (let i = 0; i + 2 <= w.length; i += 1) {
      const sub = w.slice(i, i + 2);
      const subCount = freq.get(sub) || 0;
      if (subCount > bestSubCount) { bestSub = sub; bestSubCount = subCount; }
    }
    if (bestSub && bestSubCount >= c) {
      // 子串更常见 ⇒ w 是跨界碎片：计数并入子串，自身减半
      freq.set(bestSub, bestSubCount + Math.floor(c / 2));
      freq.set(w, Math.floor(c / 2));
    }
  }
}

export function computeStats(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const topN = Math.max(1, Number(opts.topPeople) > 0 ? Number(opts.topPeople) : 5);
  const kwN = Math.max(1, Number(opts.topKeywords) > 0 ? Number(opts.topKeywords) : 8);
  const tz = String(opts.tz || 'Asia/Shanghai');

  /** 空结构（保证字段齐全，调用方无需判空）。 */
  const empty = {
    total: 0,
    people: 0,
    topPeople: [],
    hours: new Array(24).fill(0),
    peakHour: 0,
    keywords: [],
    days: 0,
  };
  if (!list.length) return empty;

  const byName = new Map();
  const hours = new Array(24).fill(0);
  const daySet = new Set();
  const texts = [];

  for (const r of list) {
    const name = String(r?.n ?? '').trim() || '匿名';
    byName.set(name, (byName.get(name) || 0) + 1);

    const ts = Number(r?.t) || 0;
    if (ts > 0) {
      // 用指定时区取小时与日期，避免服务器时区影响
      const d = new Date(ts);
      let hour;
      let dayKey;
      try {
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', hour12: false });
        hour = Number(fmt.format(d)) % 24;
        if (!Number.isFinite(hour)) hour = d.getUTCHours();
        dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      } catch {
        hour = d.getHours();
        dayKey = d.toISOString().slice(0, 10);
      }
      if (hour >= 0 && hour < 24) hours[hour] += 1;
      if (dayKey) daySet.add(dayKey);
    }

    texts.push(String(r?.text ?? ''));
  }

  // 发言排行
  const topPeople = [...byName.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, topN);

  // 峰值小时
  let peakHour = 0;
  for (let h = 1; h < 24; h += 1) if (hours[h] > hours[peakHour]) peakHour = h;

  // 关键词：排除昵称本身（避免「爱莉希雅」这种假名当话题）
  const nameSet = new Set();
  for (const name of byName.keys()) {
    nameSet.add(name);
    // 昵称里的 2~3 字片段也排除（如「张三丰」→ 张三/三丰…）
    for (const frag of name.match(CN_WORD_RE) || []) nameSet.add(frag);
  }
  const freq = countNgrams(texts, { excludeNames: nameSet });
  liftSubstrings(freq);
  const keywords = [...freq.entries()]
    .filter(([, c]) => c >= KEYWORD_MIN_COUNT)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, kwN);

  return {
    total: list.length,
    people: byName.size,
    topPeople,
    hours,
    peakHour,
    keywords,
    days: daySet.size,
  };
}

/**
 * 把 stats 压成给 LLM 看的紧凑摘要（省 token、防隐私泄漏）。
 *
 * **不喂原始消息** —— 只喂统计结果，既省 token 又不会把群友原话送进模型。
 *
 * @param {object} stats computeStats 输出
 * @returns {string}
 */
export function statsToPrompt(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  if (!Number(s.total)) return '';

  const lines = [];
  lines.push(`本群 ${Number(s.days) || 0} 天：${Number(s.total) || 0} 条群友消息，${Number(s.people) || 0} 人参与`);

  const peak = Array.isArray(s.hours) ? Number(s.hours[Number(s.peakHour)] || 0) : 0;
  if (peak > 0) lines.push(`最活跃时段：${Number(s.peakHour)}点(${peak}条)`);

  if (Array.isArray(s.topPeople) && s.topPeople.length) {
    const list = s.topPeople.map((p) => `${p.name} ${p.count}`).join('、');
    lines.push(`发言 TOP：${list}`);
  }

  if (Array.isArray(s.keywords) && s.keywords.length) {
    lines.push(`高频词：${s.keywords.map((k) => k.word).join('、')}`);
  }

  return lines.join('\n');
}

export default { computeStats, statsToPrompt };
