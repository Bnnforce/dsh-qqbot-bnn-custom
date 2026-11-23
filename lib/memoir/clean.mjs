/**
 * memoir/clean — 群消息文本清洗（R5.5 群回忆录）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块（实测数据驱动，不是拍脑袋）
 *
 * 拿真实 1748 条群消息做词频统计，结果全是噪声：
 *
 *   主人(164) 引用(70) 回复开(70) 头写(70) 再说话(70) 呜呜呜(57)
 *
 * 根因：原始消息里混着大量**非自然语言内容**：
 *   · `<@4B733314...>` 蓝色 @ 提及
 *   · `[引用 某某: "..."]` 引用块
 *   · `【表情: 微笑】` 表情占位
 *   · `【临时事件】` / `[rf:xxx]` 注入标记
 *   · `消息内容暂不能查看` 平台占位
 *   · `★主人` —— **群友手打伪造主人身份**（我们的 anti-spoof 会转成 ☆，但历史存的是原文）
 *   · `【引用】回复开头写 [rf:本条消息标签里的#短号]，再说话。` —— 群友粘贴的指令文本
 *
 * 不先清洗，任何统计/关键词/叙事都是垃圾。
 *
 * ── 两条纪律 ────────────────────────────────────────────────────────────
 *   ① **只删噪声，不删正常内容**（「主人你好」不能被当成 ★主人 删掉）
 *   ② **纯函数、零 IO、零依赖**（只 import node 内置）—— 便于单测与开源
 *
 * ── 实测数据来源 ────────────────────────────────────────────────────────
 *   {dataRoot}/.qqbot/msg-history/group_<gid>/<date>.jsonl
 *   每行：{"id","s","n","t","k","x"}，x 为正文
 *
 * ── 改动前先读 ──────────────────────────────────────────────────────────
 *   · R5.5 接口契约.md §① clean.mjs
 *   · R5.5-群回忆录-工业化方案.md §1.2 / §3.3
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 噪声规则表（顺序即执行顺序，越具体越靠前）。
 *
 * ⚠️ 顺序很重要：`【引用】回复开头写...` 必须在通用 `【...】` 之前，
 *    否则会被拆成两段残留。
 */
const NOISE_RULES = [
  // ① 群友粘贴的整段指令文本（最具体，必须最先删）
  //    真实样例：「【引用】回复开头写 [rf:本条消息标签里的#短号]，再说话。」
  [/【引用】\s*回复开头写[^。]*。?/gu, ''],
  [/回复开头写\s*\[rf:[^\]]*\]\s*[，,]?\s*再说话。?/gu, ''],

  // ② 引用块：`[引用 某某: "原文"]` 或 `[引用]`（可能带嵌套引号）
  [/\[引用[^\]]*\]/gu, ''],
  [/\[引用\][\s\S]*?(?=\n|$)/gu, ''],

  // ③ 表情占位：【表情: 微笑】
  [/【\s*表情\s*[:：][^】]*】/gu, ''],

  // ④ 媒体 / 路由 / 撤回等方括号标记
  [/\[rf:[^\]]*\]/gi, ''],
  [/\[MEDIA:[^\]]*\]/gi, ''],
  [/\[RECALL[^\]]*\]/gi, ''],
  [/\[\s*s\s*:[^\]]*\]/gi, ''],

  // ④b 卡片/小程序/分享（实测：\"[卡片消息] 小程序 摘要: [QQ小程序]... source:...\"）
  //   这类是富媒体卡片，正文是元数据不是人话，整条丢弃
  [/\[卡片消息\][\s\S]*/gu, ''],
  [/\[QQ小程序\][^\n]*/gu, ''],
  [/\bsource_logo\s*:[^\n]*/gu, ''],
  [/\bsource\s*:[^\n]*/gu, ''],
  [/\b摘要\s*:[^\n]*/gu, ''],

  // ⑤ 平台占位（消息不可见）
  //   ★ 2026-11-21 实测修正：真实文本是「暂不能查看该消息内容」（词序与预想相反），
  //     原来只匹配「消息内容暂不能查看」⇒ 完全没命中，关键词里留下
  //     「消息内/暂不能/查看该」三个碎片。现在把两种词序和片段都覆盖。
  [/暂不能查看该消息内容/gu, ''],
  [/消息内容暂不能查看/gu, ''],
  [/暂不能查看[^。\n]{0,10}内容/gu, ''],
  [/该消息已撤回/gu, ''],
  [/内容不可见/gu, ''],

  // ⑥ 蓝色 @ 提及（含 <@all>）
  [/<@[^>]*>/gu, ''],

  // ⑦ 行首伪造身份标记（只删行首，避免误伤正文里的「主人」）
  [/^\s*[★☆]\s*主人\s*/gmu, ''],

  // ⑧ 剩余注入标记【...】（放在最后，避免吃掉前面已处理的特定形态）
  [/【[^】]{0,80}】/gu, ''],

  // ⑨ 会话路由【会话 xxx】
  [/【\s*会话\s*[^】]*】/gu, ''],
  [/【\s*子会话\s*[^】]*】/gu, ''],
];

/** 纯标点/符号（清洗后只剩这些 → 视为无效）。 */
const ONLY_PUNCT_RE = /^[\s，,。.、！!？?：:；;~～\-—_=+*#@&%$^|\\/\[\]()（）【】<>《》"'`·…]+$/u;

/**
 * 清洗单条消息正文。
 *
 * @param {string} raw 原始正文（msg.x）
 * @param {{ maxLen?: number }} [opts] maxLen 默认 500（超长截断，防极端消息）
 * @returns {string} 清洗后文本；无法提取有效内容返回 ''
 */
export function cleanText(raw, opts = {}) {
  let t = String(raw ?? '');
  if (!t) return '';

  // 逐条规则删除
  for (const [re, to] of NOISE_RULES) {
    t = t.replace(re, to);
  }

  // 归一空白：换行保留（后续按行处理），行内连续空白压成一个空格
  t = t
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]{2,}/gu, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();

  // 纯标点 → 无效
  if (!t || ONLY_PUNCT_RE.test(t)) return '';

  const maxLen = Number(opts.maxLen) > 0 ? Number(opts.maxLen) : 500;
  if (t.length > maxLen) t = t.slice(0, maxLen).trim();

  return t;
}

/**
 * 批量清洗消息行。
 *
 * 过滤规则：
 *   · `me === true`（她自己说的）→ 跳过（回忆录只统计群友）
 *   · `k !== 'text'`（图片/语音/文件）→ 跳过（无正文可统计）
 *   · 清洗后为空 → 跳过
 *
 * @param {Array<{x?:string, k?:string, me?:boolean, n?:string, t?:number}>} rows
 * @returns {Array<{text:string, n:string, t:number}>}
 */
export function cleanRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.me === true) continue;                 // 她自己发的
    const kind = String(r.k ?? 'text');
    if (kind !== 'text') continue;               // 非文本
    const text = cleanText(r.x);
    if (!text) continue;
    out.push({
      text,
      n: String(r.n ?? '').trim() || '匿名',
      t: Number(r.t) || 0,
    });
  }
  return out;
}

/**
 * 判断文本里是否仍有噪声残留（测试断言用）。
 *
 * @param {string} text
 * @returns {boolean} true = 还有噪声
 */
export function hasNoise(text) {
  const t = String(text ?? '');
  if (!t) return false;
  return (
    /<@[^>]*>/u.test(t) ||
    /\[引用/u.test(t) ||
    /【[^】]*】/u.test(t) ||
    /\[rf:/i.test(t) ||
    /\[MEDIA:/i.test(t) ||
    /\[RECALL/i.test(t) ||
    /回复开头写/u.test(t) ||
    /暂不能查看|消息内容暂不能查看|该消息已撤回/u.test(t) ||
    /^\s*[★☆]\s*主人/mu.test(t)
  );
}

/**
 * 判断一段清洗后文本是否「有信息量」（用于过滤 zdjd 这类无意义串）。
 *
 * 规则：至少含 2 个连续中文，或含 3 个以上拉丁字母/数字。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isMeaningful(text) {
  const t = String(text ?? '');
  if (!t) return false;
  if (/[\u4e00-\u9fa5]{2}/u.test(t)) return true;
  if (/[A-Za-z0-9]{3}/u.test(t)) return true;
  return false;
}

export default { cleanText, cleanRows, hasNoise, isMeaningful };
