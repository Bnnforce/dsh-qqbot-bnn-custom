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
  /**
   * 按词长递增的最低频次门槛。
   *
   * ★ 2026-11-26（真机实测）：滑动窗口对 2~6 字全提取，短词碎片极多
   *   （「给我」「两个」「发送」「送者」）。真正的梗通常 3-5 字且反复出现。
   *   所以：词越短，要求出现次数越高。
   */
  countByLen: Object.freeze({ 2: 8, 3: 4, 4: 4, 5: 3, 6: 3 }),
});

/** 噪声词（永远不收）。 */
/**
 * 噪声词表。
 *
 * ★ 2026-11-26 大幅扩充（真机实测发现的问题）：
 *   第一版只挡了 27 个词，实际跑出来候选里全是：
 *     「消息内容」(204次) 「发送者」(184次) 「你们」「自己」「消息」…
 *   这些都是**功能词/系统词**，不是梗。候选表被它们淹没，人工确认时根本看不过来。
 *
 *   分四类挡：
 *     ① 口语填充词（真的/就是/然后…）
 *     ② 时间词（今天/明天/晚上…）
 *     ③ 功能词（消息/发送者/内容/你们/自己…）← 本次新增的重点
 *     ④ 系统词（卡片/图片/表情/转发…）
 */
const NOISE = new Set([
  // ① 口语填充
  '哈哈哈', '哈哈', '笑死', '真的', '这个', '那个', '什么', '怎么', '可以',
  '没有', '就是', '然后', '现在', '时候', '一个', '一下', '知道', '觉得',
  '好的', '收到', '谢谢', '不是', '还是', '已经', '应该', '可能', '但是',
  '所以', '因为', '如果', '虽然', '而且', '不过', '这样', '那样', '怎么',
  '为什么', '什么样', '怎么样', '是不是', '有没有', '能不能', '要不要',
  '好吧', '行吧', '算了', '没事', '有点', '很多', '非常', '特别', '比较',
  '一点', '一些', '大家', '我们', '他们', '她们', '咱们', '别人', '自己',
  '你们', '我你', '你我', '是他', '是她', '这是', '那是', '也是', '都是',
  // ② 时间
  '今天', '明天', '昨天', '晚上', '早上', '中午', '下午', '凌晨', '现在',
  '刚才', '刚刚', '最近', '以前', '以后', '时候', '时间', '分钟', '小时',
  '上午', '今晚', '明早', '周末', '这周', '下周', '上周',
  // ③ 功能词（实测最大的噪声来源）
  '消息', '内容', '发送者', '接收者', '群聊', '群组', '成员', '用户',
  '消息内容', '发送者名', '暂不能', '不能查看', '查看该', '该消息',
  '回复', '引用', '转发', '撤回', '通知', '提醒', '公告', '管理',
  '卡片', '按钮', '链接', '文件', '语音', '视频', '图片', '表情',
  '记录', '信息', '资料', '数据', '系统', '设置', '功能', '操作',
  // ④ 系统/占位
  '某消息', '某人', '某群', '未知', '匿名', '系统消息', '撤回消息',
  '暂不支持', '无法查看', '请稍后', '加载中', '处理中',
  // ⑤ 常见动词/量词/日常词（实测碎片大户）
  '给我', '给你', '给他', '两个', '三个', '几个', '这个', '那些', '这些',
  '脑子', '真的', '好像', '感觉', '觉得', '认为', '看来', '估计',
  '不会', '不行', '不对', '不好', '不错', '不太', '不想', '不想说',
  '说话', '说点', '说了', '说话', '问下', '问问', '回答', '告诉',
  '看到', '看到你', '听到', '想到', '记得', '忘记', '注意',
  '东西', '事情', '问题', '情况', '样子', '方式', '方法', '地方',
  '一次', '一直', '一起', '一样', '一边', '一定', '一般', '一切',
  '还有', '或者', '而且', '以及', '除了', '关于', '对于', '由于',
  // ⑥ 高频日常用语（实测残留）
  '出来', '进来', '过来', '回来', '起来', '下来', '上去', '出去',
  '不知道', '没想到', '想不到', '看不到', '找不到', '办不到',
  '什么时候', '什么地方', '什么时间', '什么样', '多少人',
  '生日快乐', '新年快乐', '节日快乐', '天天开心', '身体健康',
  '晚安', '早安', '午安', '再见', '拜拜', '加油', '辛苦了',
  '没关系', '不客气', '对不起', '不好意思', '打扰了',
  '等一下', '等等', '稍等', '马上', '一会儿', '待会',
  '第一次', '第二次', '最后一次', '这次', '下次', '每次',
  '为什么', '怎么办', '怎么样', '好不好', '行不行',
  '看到了', '听到了', '收到了', '明白了', '知道了', '懂了',
]);

/**
 * 常见短语（用于挡掉它们的碎片）。
 *
 * ★ 2026-11-26（真机实测）：「生日快乐」会被滑窗切成
 *   「生日快」「日快乐」——这些碎片出现次数够高，会混进候选。
 *   这里列出常见短语，任何「是其子串」的候选都挡掉。
 */
const COMMON_PHRASES = [
  '生日快乐', '新年快乐', '节日快乐', '天天开心', '身体健康', '恭喜发财',
  '什么时候', '什么地方', '不好意思', '没关系', '不客气', '对不起',
  '辛苦了', '等一下', '为什么', '怎么办', '怎么样', '不知道',
  '没想到', '第一次', '最后一次', '看到了', '听到了', '知道了',
  '群聊的聊天记录', '消息内容', '发送者', '接收者', '暂不能查看',
];

/** 纯功能词/系统词的后缀（如「xx内容」「xx发送者」）。 */
const NOISE_SUFFIX = ['内容', '发送者', '接收者', '消息', '通知', '记录'];

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
  // ★ 2026-11-26：先剔除结构性噪声，再提词
  //   ① @标记 / <...> 标签（会带出 openid 或系统标签）
  //   ② 网址
  //   ③ 【表情: xxx】这类占位
  const cleaned = t
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\[图片\]|\[表情\]|\[语音\]|\[视频\]/g, ' ');

  // 先切出连续中文段
  const runs = cleaned.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of runs) {
    for (let len = THRESHOLD.minWordLen; len <= THRESHOLD.maxWordLen; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const w = run.slice(i, i + len);
        if (NOISE.has(w)) continue;
        // 纯功能词后缀（「xx内容」「xx发送者」）也挡掉
        if (NOISE_SUFFIX.some((sfx) => w.endsWith(sfx))) continue;
        // 常见短语的碎片（「生日快」是「生日快乐」的子串）也挡掉
        if (COMMON_PHRASES.some((ph) => ph.includes(w) && ph !== w)) continue;
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

    // ★ 2026-11-26（真机实测）：整条消息级别的过滤。
    //   实测发现噪声主要来自两类**非对话**消息，它们会刷出几百次假候选：
    //     ① 合并转发的聊天记录：[群聊的聊天记录] === 消息 1 === [消息内容] … [发送者] …
    //        → 「消息内容」出现 204 次、「发送者」184 次，全是它贡献的
    //     ② 系统占位消息：暂不能查看该消息内容 / [图片] / [表情]
    //   这类消息本身不含「群友自造词」，整条跳过即可。
    if (text.includes('[群聊的聊天记录]') || text.includes('=== 消息 ')) continue;
    if (text.includes('暂不能查看') || text.includes('无法查看该消息')) continue;
    if (/^\[(图片|表情|语音|视频|文件|卡片)\]$/.test(text.trim())) continue;
    // 超长消息（>500 字）通常是转发的长文/小说，不是日常对话
    if (text.length > 500) continue;

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
    if (st.people.size < THRESHOLD.minPeople) continue;

    // ★ 按词长取不同门槛（短词要求更高频次，滤掉碎片）
    const needCount = THRESHOLD.countByLen[word.length] ?? THRESHOLD.minCount;
    if (st.count < needCount) continue;

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
