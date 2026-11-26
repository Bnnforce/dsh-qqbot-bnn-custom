/**
 * slang-harvest — 梗的自动发现（R8，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 现状（实测）：
 *   · 只有 1 个群有黑话本，6 条
 *   · 候选机制设计了但**从没产生过文件**
 *   · 没有任何自动发现
 *
 * 本模块做的事：从群聊里找出「反复出现但不在词典里」的词。
 *
 * ── 关键纪律：只产候选，不自动进黑话本 ──────────────────────────────────
 *
 *   自动收词会把「哈哈哈」「笑死」这类噪声全收进去。
 *   所以：**必须主人确认**才进黑话.md。
 *
 *   ⚠️ 零风险设计：只写候选.md，绝不碰黑话.md（那是已确认的权威数据）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { WORKSPACE_ROOT } from '../pack-paths.mjs';

/** 黑话本根。 */
const SLANG_ROOT = join(WORKSPACE_ROOT, 'Bot', '人格', '黑话本');

/** 候选门槛。 */
export const THRESHOLD = Object.freeze({
  minWordLen: 2,      // 最短 2 字
  maxWordLen: 6,      // 最长 6 字
  minCount: 3,        // 至少出现 3 次
  minPeople: 2,       // 至少 2 人用过
});

/** 噪声词（永远不收）。 */
const NOISE = new Set([
  '哈哈哈', '哈哈', '笑死', '真的', '这个', '那个', '什么', '怎么', '可以',
  '没有', '就是', '然后', '现在', '时候', '一个', '一下', '知道', '觉得',
  '今天', '明天', '昨天', '晚上', '早上', '中午', '好的', '收到', '谢谢',
]);

/**
 * 从一条消息里提取可能的「词」。
 *
 * ★ 2026-11-26 修（真 bug）：
 *   第一版用 /[\u4e00-\u9fa5]{2,6}/g 贪婪匹配，
 *   「大鲸鱼今天来了吗」会被整体吞成「大鲸鱼今天来」——
 *   结果永远提不出「大鲸鱼」这个真正的梗，harvest 恒返回 0。
 *
 *   改用**滑动窗口**：对每段连续中文，取所有长度 2~6 的子串。
 *   这样「大鲸鱼」会被提出来，而且靠「出现次数」自然过滤掉噪声
 *   （随机子串出现 3 次以上且 2 人用过的概率很低）。
 */
function extractCandidates(text) {
  const t = String(text ?? '');
  const out = [];
  // 先切出连续中文段
  const runs = t.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of runs) {
    for (let len = THRESHOLD.minWordLen; len <= THRESHOLD.maxWordLen; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const w = run.slice(i, i + len);
        if (NOISE.has(w)) continue;
        out.push(w);
      }
    }
  }
  return out;
}

/**
 * 从消息列表里找出候选梗（纯函数）。
 *
 * @param {Array<{s:string, x:string}>} messages
 * @param {Set<string>} knownWords 已在黑话本里的词
 * @returns {Array<{word:string, count:number, people:number, sample:string}>}
 */
export function harvest(messages, knownWords = new Set()) {
  const list = Array.isArray(messages) ? messages : [];
  const stats = new Map();   // word → { count, people:Set, sample }

  for (const m of list) {
    const text = String(m?.x ?? '');
    if (!text || text.startsWith('/')) continue;
    const sender = String(m?.s ?? '');
    for (const w of extractCandidates(text)) {
      if (knownWords.has(w)) continue;
      if (!stats.has(w)) stats.set(w, { count: 0, people: new Set(), sample: text.slice(0, 60) });
      const st = stats.get(w);
      st.count += 1;
      if (sender) st.people.add(sender);
    }
  }

  const out = [];
  for (const [word, st] of stats) {
    if (st.count < THRESHOLD.minCount) continue;
    if (st.people.size < THRESHOLD.minPeople) continue;
    out.push({ word, count: st.count, people: st.people.size, sample: st.sample });
  }
  // 按「人数 × 次数」排序
  out.sort((a, b) => (b.people * b.count) - (a.people * a.count));

  // ★ 2026-11-26：去掉「被更长词包含」的短词
  //   滑动窗口会把「大鲸鱼」拆出「大鲸」「鲸鱼」——那是同一个梗的碎片。
  //   只保留最长的那个，避免候选表被碎片淹没。
  const words = out.map((c) => c.word);
  return out.filter((c) => {
    for (const other of words) {
      if (other === c.word) continue;
      if (other.length > c.word.length && other.includes(c.word)) return false;
    }
    return true;
  });
}

/** 读已确认的黑话（只读，用于排除）。 */
export function readKnownWords(gid) {
  const bare = String(gid ?? '').replace(/^group_/, '').slice(0, 8);
  const file = join(SLANG_ROOT, bare, '黑话.md');
  const set = new Set();
  try {
    const raw = readFileSync(file, 'utf8');
    for (const b of raw.split(/^## /m).slice(1)) {
      const w = String(b.split('\n')[0] ?? '').trim();
      if (w) set.add(w);
    }
  } catch { /* 无黑话本 */ }
  return set;
}

/**
 * 写候选文件（**只写候选.md，绝不碰黑话.md**）。
 *
 * @param {string} gid
 * @param {Array<object>} candidates
 * @returns {boolean}
 */
export function writeCandidates(gid, candidates) {
  const bare = String(gid ?? '').replace(/^group_/, '').slice(0, 8);
  if (!bare) return false;
  const dir = join(SLANG_ROOT, bare);
  try {
    mkdirSync(dir, { recursive: true });
    const lines = [
      `# 群内黑话候选（${bare}）`,
      '',
      '> ⚠️ 这些是**自动发现**的候选，未经确认，**不会**进上下文。',
      '> 确认后手动移到 `黑话.md` 才会生效。',
      '',
      `> 生成时间：${new Date().toISOString()}`,
      '',
    ];
    for (const c of candidates.slice(0, 50)) {
      lines.push(`## ${c.word}`);
      lines.push(`- 出现 ${c.count} 次，${c.people} 人用过`);
      lines.push(`- 例：${c.sample}`);
      lines.push('');
    }
    writeFileSync(join(dir, '候选.md'), lines.join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次完整的采集（读消息 → 找候选 → 写候选文件）。
 *
 * @param {string} gid
 * @param {Array<object>} messages
 * @returns {{found:number, written:boolean}}
 */
export function harvestAndSave(gid, messages) {
  const known = readKnownWords(gid);
  const candidates = harvest(messages, known);
  if (!candidates.length) return { found: 0, written: false };
  return { found: candidates.length, written: writeCandidates(gid, candidates) };
}

export default {
  THRESHOLD, harvest, readKnownWords, writeCandidates, harvestAndSave,
};
