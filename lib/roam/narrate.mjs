/**
 * roam/narrate — 让她像人一样说，不像营销号（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是整个功能的成败关键
 *   技术再通，一旦她说成「这个视频讲了……」，就退化成内容搬运工。
 *   所以 prompt 里必须有**硬约束**，且输出要本地强校验。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 官方 wakeTo 三要点（extension-contract.md:547）
 *   ① 自报家门：说明这是系统提示，不是群友说的话
 *   ② 说清要做什么
 *   ③ 禁止项
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { diag as diagStat } from './store.mjs';

/** 兜底文案（模型不听话时用）。 */
const FALLBACK_LINES = Object.freeze([
  '刚刷到这个，有点意思。',
  '这个我看了，还不错。',
  '刚好看到，分享给你。',
]);

/**
 * 构建 wakePrompt：让 AI 说一句感受。
 *
 * @param {object} result watch() 的返回
 * @param {object} cfg
 * @param {{reason?:string}} [opts] reason='link'（被动）| 'roam'（主动）
 * @returns {string}
 */
export function buildWatchPrompt(result, cfg, opts) {
  const maxChars = Number.isFinite(cfg?.promptMaxChars) ? cfg.promptMaxChars : 40;
  const reason = opts?.reason || 'link';
  const meta = result?.meta || {};
  const L = [];

  L.push('【系统提示 · 不是群友说的话】');
  L.push('');
  L.push('你刚看到一个 B站 视频：');
  L.push('  标题：' + String(meta.title || '(未知)').slice(0, 60));
  if (meta.author) L.push('  UP主：' + String(meta.author).slice(0, 30));
  if (Number.isFinite(meta.duration) && meta.duration > 0) {
    const m = Math.floor(meta.duration / 60);
    const s = meta.duration % 60;
    L.push('  时长：' + (m > 0 ? m + '分' : '') + (s > 0 ? s + '秒' : ''));
  }
  L.push('');

  if (result?.subtitle?.text) {
    L.push('【视频里说了什么（节选，仅供你理解，不要复述）】');
    L.push(String(result.subtitle.text).slice(0, 300));
    L.push('');
  }

  L.push('【本轮任务】');
  L.push(reason === 'roam'
    ? '你正好刷到这个，觉得有点意思。用你自己的话在群里说一句。'
    : '有人发了这个链接。用你自己的话回一句。');
  L.push('');
  L.push('【硬约束·必须遵守】');
  L.push('- 只说你自己的感受或想法，不要复述视频内容。');
  L.push('- 最多两句，不超过 ' + maxChars + ' 字。');
  L.push('- 不许说"这个视频讲了""内容是""博主说"这类话。');
  L.push('- 不许念字幕、不许列要点、不许科普。');
  L.push('- 不许说"我查了一下""我看到一个视频"。');
  L.push('- ★ 不要输出 HTML 标签（<p> <br> <div> 等），不要输出 <@xxx>。');
  L.push('- ★ 不要自己拼 markdown 链接 [文字](url)，也不要自己假装发卡片。');
  L.push('- ★ 真要分享卡片，在 bili_watch 里加 share:true，别自己写。');
  L.push('- 不想说就不说，直接输出沉默也可以 —— 但不要敷衍。');
  L.push('');
  L.push('按你的人格说话。只输出消息正文，不要加任何标记。');

  return L.join(String.fromCharCode(10));
}

/**
 * 本地强校验：剥掉模型可能加的元信息前缀/引号，限制长度。
 *
 * 原则：绝不盲信模型输出。
 *
 * ═══ 2026-11-23 出站误伤修复（真实事故）═══
 *
 * 这个函数原本只服务 R5.7（命令 return {wake} → AI 说一句 → 直接发群），
 * 所以规则写得很激进。后来 `outbound/56-roam-clean.mjs` 把它挂到**全局出站链**上，
 * 于是它对**所有**纯文字出站生效 —— 结果误伤普通消息：
 *
 *   `**注意**：明天两点开会`        → `明天两点开会`      ← 前缀被吃
 *   `https://b23.tv/abc 必须看`    → `//b23.tv/abc 必须看` ← 协议头被吃！
 *   `<@openid> 真的假的`           → `真的假的`           ← 刚补的 @ 被剥
 *   `第一行\n第二行`               → `第一行 第二行`      ← 多行压平
 *
 * 根因是这几条规则**只看"是不是像元信息"，不看上下文**：
 *   规则 4（行首「若干字 + 冒号」）会吃掉 `https`、`注意`、`价格表` 任何 1-8 字前缀；
 *   规则 4.6 会剥任何 `<@...>`（而出站链里 @ 的语义归 10-ensure-at-back / 上游 markers.js 管）；
 *   规则 5（空白折叠）会毁掉分段依据（60-split-bubbles 靠换行拆气泡）。
 *
 * 修法：加**开关**，默认值保持**原有行为**（R5.7 的 444 条断言不能动），
 * 只有全局出站场景才关掉那几条会误伤的规则。
 *
 * @param {string} raw
 * @param {object} cfg  配置（读 promptMaxChars）
 * @param {object} [opt] 行为开关。**默认全部 = 旧行为**（R5.7 的 444 条断言依赖它，
 *   必须保持向后兼容）；只有全局出站场景才显式传 false 关掉会误伤的规则。
 *   @param {boolean} [opt.stripNamePrefix=true] 是否剥行首「名字：」前缀
 *   @param {boolean} [opt.stripMentions=true]   是否剥 `<@...>` 的 @ 标记
 *   @param {boolean} [opt.keepLines=false]      是否保留换行（只折叠行内空白）
 * @returns {string} 可发出去的正文；空串表示不该发
 */
export function sanitizeOutput(raw, cfg, opt = {}) {
  const maxChars = Number.isFinite(cfg?.promptMaxChars) ? cfg.promptMaxChars : 40;
  // ★ 默认 true = 保持 R5.7 原有激进行为（旧调用方一个参数都不用改）
  const stripNamePrefix = opt?.stripNamePrefix !== false;
  const stripMentions = opt?.stripMentions !== false;
  const keepLines = opt?.keepLines === true;
  let t = String(raw ?? '').trim();
  if (!t) return '';

  // 1) 去掉包在前面的方括号/圆括号元信息
  t = t.replace(/^[【\[（(][^】\]）)]{0,20}[】\]）)]\s*/, '');
  // 2) 去掉常见前缀
  t = t.replace(/^(回复|回答|输出|消息正文|正文)[:：]\s*/, '');
  // 3) 去掉首尾引号包裹
  t = t.replace(/^[「『"'“”]+/, '').replace(/[」』"'“”]+$/, '');
  // 4) 去掉行首名字前缀（如「爱莉希雅：」）
  //    ⚠️ 只在显式开启时做 —— 它会把 `https` / `注意` / `价格表` 当名字吃掉。
  if (stripNamePrefix) t = t.replace(/^[^\s:：]{1,8}[:：]\s*/, '');
  // 4.5) ★ 剥 HTML 标签（实测她会自己输出 <p>UP：xxx</p>）
  t = t.replace(/<\/?[a-z][^>]{0,80}>/gi, '');
  // 4.6) ★ 剥 QQ 的 @ 标记（<@openid>）
  //    ⚠️ 只在显式开启时做 —— 出站链里 @ 是 10-ensure-at-back 的职责，这里剥了会让它白干。
  if (stripMentions) t = t.replace(/<@!?[^>]{0,60}>/g, '');
  // 4.7) ★ 剥 markdown 链接，只留文字
  t = t.replace(/\[([^\]]{1,80})\]\([^)]{0,200}\)/g, '$1');
  // 4.8) ★ 剥粗体/斜体标记
  t = t.replace(/\*\*([^*]{1,80})\*\*/g, '$1').replace(/__([^_]{1,80})__/g, '$1');
  // 4.9) ★ 剥行首标题井号
  t = t.replace(/^#+\s*/gm, '');
  // 4.10) ★ 剥 HTML 实体
  t = t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // 5) 折叠空白
  //    ⚠️ keepLines=true 时只折叠行内空白，保留换行（60-split-bubbles 靠换行拆气泡）
  t = keepLines
    ? t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    : t.replace(/\s+/g, ' ').trim();
  // 6) 空/纯标点 → 不发
  //    ⚠️ 2026-11-23：主动逛没找到内容时她会输出「。」，这里要挡掉（不发空消息）
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return '';
  // 7) 超长截断 —— ⚠️ 按句子边界切，不要切在词中间（2026-11-23 打磨）
  const chars = [...t];
  if (chars.length > maxChars) {
    t = cutAtBoundary(t, maxChars);
  }

  // 8) 质量统计（2026-11-23 打磨）
  //    记录「原X字 → 清Y字」，便于事后看她说了多少、被切了多少
  try {
    const origLen = [...String(raw ?? '')].length;
    const finalLen = [...t.trim()].length;
    if (origLen > 0 && finalLen !== origLen) {
      diagStat('[质量] 原' + origLen + '字 → ' + finalLen + '字'
        + (finalLen < origLen ? '（少' + (origLen - finalLen) + '）' : ''));
    }
  } catch { /* 统计失败绝不影响返回 */ }

  return t.trim();
}

/**
 * 在字数上限内，尽量切在**句子边界**（。！？；）而不是词中间。
 *
 * 策略（从好到差）：
 *   1. 上限内最后一个句末标点 → 用它的位置
 *   2. 上限内最后一个逗号/顿号 → 用它的位置
 *   3. 上限内最后一个空格 → 用它的位置
 *   4. 都没有 → 硬切（保底）
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function cutAtBoundary(text, maxChars) {
  const chars = [...String(text ?? '')];
  const max = Number.isFinite(maxChars) ? Math.max(1, maxChars) : 70;
  if (chars.length <= max) return chars.join('');

  const head = chars.slice(0, max);

  // ⚠️ 2026-11-23 打磨：阈值 0.6 → 0.4
  //   0.6 太严：句子短时（如「这是第一句。」只占 37%）会被跳过，退到逗号硬切，
  //   反而不如保留完整短句。0.4 更符合「能留完整句就留」的意图。
  const MIN_KEEP = 0.4;

  // 1) 句末标点
  const SENT_END = /[。！？；!?;]/;
  for (let i = head.length - 1; i >= Math.floor(max * MIN_KEEP); i--) {
    if (SENT_END.test(head[i])) return head.slice(0, i + 1).join('');
  }

  // 2) 逗号/顿号
  const CLAUSE = /[，、,]/;
  for (let i = head.length - 1; i >= Math.floor(max * MIN_KEEP); i--) {
    if (CLAUSE.test(head[i])) return head.slice(0, i).join('') + '…';
  }

  // 3) 空格
  for (let i = head.length - 1; i >= Math.floor(max * MIN_KEEP); i--) {
    if (/\s/.test(head[i])) return head.slice(0, i).join('');
  }

  // 4) 硬切（保底）
  return head.join('') + '…';
}

/** 兜底文案（模型输出不可用时）。 */
export function fallbackLine(seed) {
  const n = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 0;
  return FALLBACK_LINES[n % FALLBACK_LINES.length];
}

/** 构建链接提示（不含视频内容，只提示可以去看）。 */
export function buildLinkPrompt(bvid) {
  const L = [
    '【系统提示 · 不是群友说的话】',
    '',
    '群里有人发了 B站 视频：' + String(bvid || ''),
    '',
    '你可以用 bili_watch 工具看一下；不想看就不用理。',
  ];
  return L.join(String.fromCharCode(10));
}

export default { buildWatchPrompt, sanitizeOutput, fallbackLine, buildLinkPrompt, FALLBACK_LINES };
