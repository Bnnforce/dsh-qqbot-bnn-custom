/**
 * topic — 群聊话题识别（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纯算法，不用 LLM（7 群 × 每天，LLM 成本不可接受）。
 *
 * 思路：
 *   ① 先 cleanMessages 清洗（已验证：不过滤会被「消息内容」噪声淹没）
 *   ② 滑动窗口提词（复用 harvest 的思路，但排除功能词）
 *   ③ 词频聚类：高频词 + 多人参与 = 话题
 *
 * 阈值（可配置）：
 *   · minPeople ≥ 3 人用过
 *   · minMsgs ≥ 5 条
 *   · 窗口 3-7 天
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 隐私红线：输出不含 openid，只有话题词 + 人数 + 消息数。
 */
import { cleanMessages } from './noise-filter.mjs';

/** 功能词（停止词）—— 不是话题。 */
const STOP_WORDS = new Set([
  // 疑问/指代
  '什么', '意思', '怎么', '为什么', '哪个', '哪里', '这个', '那个', '这些', '那些',
  // 否定/判断
  '不是', '没有', '不会', '不能', '不要', '还是', '就是', '但是', '如果',
  // 量词/频率
  '一个', '一次', '一下', '一起', '一直', '有点', '一点',
  // 人称
  '自己', '你的', '我的', '他的', '她的', '我们', '你们', '他们', '身上',
  // 时间
  '时候', '现在', '今天', '明天', '昨天', '晚上', '早上', '中午', '然后',
  // 程度/语气
  '真的', '好像', '应该', '已经', '可能', '不过', '只是', '而且', '或者', '可以',
  '这样', '那样', '知道', '觉得', '因为', '所以', '清楚', '说清', '说话',
  '哈哈', '哈哈哈', '卧槽', '卧槽卧槽', '不错', '好的', '收到', '谢谢', '不用', '没事',
  // 常用动词/助词/连接
  '出来', '东西', '都是', '我说', '说', '看', '觉得', '知道', '什么', '时候',
  '出来', '起来', '一下', '知道', '就是', '这么', '那么', '怎么样',
  // 表情标签
  '图片', '表情', '图片表情',
]);

/** 默认阈值。 */
export const TOPIC_DEFAULTS = Object.freeze({
  minPeople: 3,
  minMsgs: 5,
  minWordLen: 2,
  maxWordLen: 4,
  topN: 10,
});

/**
 * 从一条消息提取候选词（滑动窗口，排除功能词）。
 *
 * @param {string} text
 * @param {object} cfg
 * @returns {string[]}
 */
function wordsOf(text, cfg) {
  const t = String(text ?? '')
    .replace(/@[\w\u4e00-\u9fa5]+/g, ' ')     // 去掉 @ 提及
    .replace(/【[^】]*】/g, ' ')               // 去掉表情标签
    .replace(/https?:\/\/\S+/g, ' ');          // 去掉链接

  const out = [];
  const seen = new Set();
  const runs = t.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of runs) {
    for (let len = cfg.minWordLen; len <= cfg.maxWordLen; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const w = run.slice(i, i + len);
        if (STOP_WORDS.has(w) || seen.has(w)) continue;
        seen.add(w);
        out.push(w);
      }
    }
  }
  return out;
}

/** 子串去重：被更长词包含的短词去掉（「排行榜」优先于「行榜」「排行」）。 */
function dedupeSubstrings(items) {
  const words = items.map((i) => i.word);
  return items.filter((it) => {
    for (const other of words) {
      if (other === it.word) continue;
      if (other.length > it.word.length && other.includes(it.word)) return false;
    }
    return true;
  });
}

/** 语法碎片前缀/后缀：这类 2 字词 90% 是无意义的滑动窗口碎片。 */
const FRAGMENT_AFFIX = new Set(['过', '这', '那', '是', '的', '了', '不', '也', '就', '都', '很', '把', '被', '给']);

/** 过滤语法碎片（2 字词以语法助词开头/结尾）。 */
function isFragment(word) {
  if (word.length !== 2) return false;
  return FRAGMENT_AFFIX.has(word[0]) || FRAGMENT_AFFIX.has(word[1]);
}

/**
 * 识别话题（纯函数）。
 *
 * @param {Array<{s?:string, x?:string, t?:number}>} messages 原始消息
 * @param {object} [opts] 覆盖 TOPIC_DEFAULTS
 * @returns {{topics:Array<{word:string, people:number, msgs:number}>, stats:object}}
 */
export function detectTopics(messages, opts = {}) {
  const cfg = { ...TOPIC_DEFAULTS, ...(opts ?? {}) };

  // ① 清洗
  const { clean, stats } = cleanMessages(messages);

  // ② 词频 + 人数统计
  const wordStats = new Map();   // word → { count, people:Set }
  for (const m of clean) {
    const sender = String(m?.s ?? '');
    for (const w of wordsOf(m.x, cfg)) {
      if (!wordStats.has(w)) wordStats.set(w, { count: 0, people: new Set() });
      const st = wordStats.get(w);
      st.count += 1;
      if (sender) st.people.add(sender);
    }
  }

  // ③ 过滤：≥ minPeople 人 + ≥ minMsgs 条 + 非碎片
  const candidates = [];
  for (const [word, st] of wordStats) {
    if (st.count < cfg.minMsgs) continue;
    if (st.people.size < cfg.minPeople) continue;
    if (isFragment(word)) continue;       // 语法碎片
    candidates.push({ word, people: st.people.size, msgs: st.count });
  }

  // ④ 子串去重 + 排序 + 截断
  const deduped = dedupeSubstrings(candidates);
  deduped.sort((a, b) => (b.people * b.msgs) - (a.people * a.msgs));

  return {
    topics: deduped.slice(0, cfg.topN),
    stats: {
      ...stats,
      candidates: candidates.length,
      topics: deduped.length,
    },
  };
}

export default { TOPIC_DEFAULTS, detectTopics };
