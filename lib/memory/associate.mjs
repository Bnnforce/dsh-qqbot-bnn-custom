/**
 * memory/associate — 发散联想（R8，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个（主人原话）：
 *
 *   「各个记忆模块和相关的功能模块能互相联动，人格和模型也能自动去寻找，
 *     让它自己去像更像一个人一样，发散的思维去寻找信息」
 *
 * ── 现在的问题 ─────────────────────────────────────────────────────────────
 *
 *   当前的记忆召回是**单向一次检索**：
 *     上一条用户消息 → 语义检索 → 返回几条 → 结束
 *
 *   这不像人。人听到一句话会**发散**：
 *     「你还记得上次那家店吗」
 *       → 那家店（直接对象）
 *       → 上次去的人（相关人）
 *       → 当时聊了什么（相关事）
 *       → 谁当时说好吃（关系）
 *       → 群里有没有关于它的黑话（梗）
 *
 * ── 本模块做的事 ───────────────────────────────────────────────────────────
 *
 *   从一句话出发，做**三跳联想**（可配置跳数）：
 *
 *     第 1 跳：关键词 → 命中的记忆（人/事/梗/关系）
 *     第 2 跳：从命中的实体 → 关联的其他记忆
 *     第 3 跳：从关联 → 再一层（默认关闭，防爆炸）
 *
 *   全部只读，零风险。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  readChronicle, readRelations, readSlang, readBirthdays, readPersonCard,
} from './read.mjs';

/** 联想配置。 */
export const ASSOC = Object.freeze({
  /** 最多跳几层（2 = 人→事，3 = 人→事→人）。 */
  maxHops: 2,
  /** 每层最多取几条。 */
  perHopLimit: 3,
  /** 总输出上限（防 token 爆炸）。 */
  totalLimit: 8,
  /** 关键词最短长度（太短会乱匹配）。 */
  minKeywordLen: 2,
});

/** 从文本提取候选关键词（去停用词）。 */
const STOP = new Set([
  // 单字停用词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那',
  '还', '也', '都', '就', '又', '才', '把', '被', '给', '让', '对', '和', '与',
  '啊', '吧', '吗', '呢', '呀', '哦', '嗯', '哈', '嘛', '呗', '啦',
  // 多字停用词
  '什么', '怎么', '为什么', '可以', '没有', '就是', '然后', '现在',
  '一个', '一下', '知道', '觉得', '时候', '还是', '因为', '所以',
  '记得', '那次', '这个', '那个', '这样', '那样', '我们', '你们', '他们',
]);

/**
 * 提取关键词（纯函数）。
 *
 * 不追求完美分词——用「连续中文 2-4 字」的滑动窗口 + 停用词过滤，
 * 足够用于联想触发。
 *
 * @param {string} text
 * @param {{max?:number}} [opts]
 * @returns {string[]}
 */
export function keywordsOf(text, opts = {}) {
  const t = String(text ?? '');
  const max = Number(opts.max) > 0 ? Number(opts.max) : 6;
  const out = [];
  const seen = new Set();

  const runs = t.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of runs) {
    for (let len = ASSOC.minKeywordLen; len <= 4; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const w = run.slice(i, i + len);
        if (STOP.has(w) || seen.has(w)) continue;
        seen.add(w);
        out.push(w);
      }
    }
  }
  // ★ 2026-11-26 优化：去掉「含停用词」的碎片
  //   第一版会产出「你还记得」「还记得莫」这种跨词碎片，
  //   它们匹配不到任何真实记忆，纯噪声。
  const clean = out.filter((w) => ![...STOP].some((s) => w.includes(s) && w !== s));

  // 长的优先（更具体）
  clean.sort((a, b) => b.length - a.length);
  return clean.slice(0, max);
}

/**
 * 从一句话出发做发散联想。
 *
 * @param {string} gid 群 id
 * @param {string} text 当前这句话
 * @param {{maxHops?:number, perHopLimit?:number}} [opts]
 * @returns {{keywords:string[], hits:Array<object>, summary:string}}
 */
export function associate(gid, text, opts = {}) {
  const maxHops = Number(opts.maxHops) > 0 ? Number(opts.maxHops) : ASSOC.maxHops;
  const perHop = Number(opts.perHopLimit) > 0 ? Number(opts.perHopLimit) : ASSOC.perHopLimit;

  const keywords = keywordsOf(text);
  if (!keywords.length) return { keywords: [], hits: [], summary: '' };

  const hits = [];
  const seenKeys = new Set();

  const push = (hit) => {
    if (hits.length >= ASSOC.totalLimit) return;
    const key = `${hit.kind}:${hit.id}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    hits.push(hit);
  };

  // ── 第 1 跳：关键词 → 直接命中 ──────────────────────────────────────────
  const slang = readSlang(gid);
  for (const kw of keywords) {
    for (const s of slang) {
      if (s.word.includes(kw) || kw.includes(s.word)) {
        push({ kind: 'slang', id: s.word, hop: 1, text: `${s.word} = ${s.meaning}` });
      }
    }
  }

  const bdays = readBirthdays(gid);
  for (const kw of keywords) {
    for (const b of bdays) {
      if (b.name.includes(kw) || kw.includes(b.name)) {
        push({ kind: 'birthday', id: b.name, hop: 1, text: `${b.name} 的生日是 ${b.date}` });
      }
    }
  }

  const events = readChronicle(gid);
  for (const kw of keywords) {
    for (const e of events) {
      // 事件只有日期/人数/得分，没有正文；用日期做弱匹配
      if (String(e.date ?? '').includes(kw)) {
        push({
          kind: 'event', id: String(e.date), hop: 1,
          text: `${e.date} 有 ${Array.isArray(e.participants) ? e.participants.length : 0} 人聊了 ${e.msgCount} 条`,
        });
      }
    }
  }

  // ── 第 2 跳：从已命中实体 → 关联 ────────────────────────────────────────
  if (maxHops >= 2 && hits.length < ASSOC.totalLimit) {
    const rels = readRelations(gid);

    // 2a. 命中了梗 → 找用过这个梗的群友（关系里的高频对）
    for (const h of [...hits]) {
      if (h.kind !== 'slang') continue;
      const top = Object.entries(rels)
        .sort((a, b) => (Number(b[1]?.interactions) || 0) - (Number(a[1]?.interactions) || 0))
        .slice(0, perHop);
      for (const [key, rel] of top) {
        push({
          kind: 'relation', id: key, hop: 2,
          text: `常聊的一对（互动 ${rel?.interactions ?? 0} 次${rel?.close ? '，挺熟' : ''}）`,
        });
      }
      break;
    }

    // 2b. 命中了生日 → 补这个人的人物卡摘要
    for (const h of [...hits]) {
      if (h.kind !== 'birthday') continue;
      const card = readPersonCard(gid, h.id);
      if (card) {
        const brief = card.split('\n').filter((l) => l.startsWith('- ') && !l.includes('openid')).slice(0, 2).join('；');
        if (brief) push({ kind: 'person', id: h.id, hop: 2, text: brief });
      }
    }
  }

  return { keywords, hits, summary: renderAssoc(hits) };
}

/**
 * 把联想结果渲染成给模型看的一段（纯函数）。
 *
 * @param {Array<object>} hits
 * @returns {string}
 */
export function renderAssoc(hits) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return '';
  const lines = list.map((h) => `· ${h.text}`);
  return lines.join('\n');
}

/**
 * 生成「可查清单」——告诉模型它还能查什么。
 *
 * 这是「让模型自己发散」的关键：不是系统替它联想，
 * 而是告诉它「你手上有这些能力，自己决定查不查」。
 *
 * @param {string} gid
 * @returns {string}
 */
export function hintFor(gid) {
  try {
    const slang = readSlang(gid).length;
    const events = readChronicle(gid).length;
    const rels = Object.keys(readRelations(gid)).length;
    const bdays = readBirthdays(gid).length;

    const parts = [];
    if (slang) parts.push(`${slang} 个群黑话`);
    if (events) parts.push(`${events} 段群史`);
    if (rels) parts.push(`${rels} 对关系`);
    if (bdays) parts.push(`${bdays} 个生日`);
    if (!parts.length) return '';

    return `（你还能查：${parts.join('、')}。想到相关的就用 memory_query 查一下，别硬编）`;
  } catch {
    return '';
  }
}

export default {
  ASSOC, keywordsOf, associate, renderAssoc, hintFor,
};
