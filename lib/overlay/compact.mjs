/**
 * overlay-compact — 从人格卡自动生成「身份提醒摘要」（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用途
 *   完整人格卡 14KB 只在**首次**注入；之后 overlay 被压缩折叠时，
 *   注入这份 ≤1500 字符的摘要补位（保证"记得自己是谁"，又不白烧 token）。
 *
 * 为什么从卡里自动提取，而不是手写一份摘要：
 *   ① 人格卡改了 → 摘要自动跟着变，不会出现"卡改了摘要没改"的不一致
 *   ② 单一数据源（工业化原则：一处维护，处处一致）
 *   ③ 新增人格零成本（不用为每个人格手写）
 *
 * 提取哪几段（都是"最不能错"的）：
 *   · §1.2 一句话定位      —— 她是谁
 *   · §2.1 性格标签前 3 条  —— 她怎么表现
 *   · §3.5b 禁语清单        —— 她绝不说的话
 *   · §4.3 边界与底线前 3 条 —— 她的雷区
 *
 * 失败降级：任何一步提取失败 → 返回空串，调用方回退到注入完整卡。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 摘要硬上限（超出就截断，保证成本可预测）。 */
export const COMPACT_MAX_CHARS = 1500;

/**
 * 从 markdown 里取某个 `## 标题` 段的内容行。
 *
 * @param {string} md      整张卡的 markdown
 * @param {RegExp} titleRe 匹配标题的正则（只需匹配标题那行）
 * @param {number} maxLines 最多取几行（0/缺省 = 不限制）
 * @returns {string[]}     内容行（已 trim，去掉空行与 markdown 表格分隔）
 */
export function extractSectionLines(md, titleRe, maxLines = 0) {
  const lines = String(md ?? '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (titleRe.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return [];

  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    // 遇到同级或更高级标题 → 本段结束
    if (/^#{1,2}\s/.test(raw)) break;
    const t = raw.trim();
    if (!t) continue;
    // 跳过子标题（### / ####）：它们只是分段标记，不是内容
    if (/^#{3,}\s/.test(t)) continue;
    // 跳过表格分隔行与纯分隔线
    if (/^\|?[\s:|-]+\|?$/.test(t) && t.includes('-')) continue;
    // 跳过表头行（|---|---| 之后紧跟的那种没意义）
    if (/^\|\s*(不能说|项目|字段)\s*\|/.test(t)) continue;
    // 去掉 markdown 标记，保留文字
    out.push(t.replace(/\*\*/g, '').replace(/^[-*]\s+/, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim());
    if (maxLines > 0 && out.length >= maxLines) break;
  }
  return out;
}

/**
 * 生成人格摘要。
 *
 * @param {string} cardText  完整人格卡 markdown
 * @param {string} name      人格名
 * @returns {string}         ≤COMPACT_MAX_CHARS 的摘要；提取不到关键段时返回 ''
 */
export function buildCompactOverlay(cardText, name) {
  const card = String(cardText ?? '');
  const personaName = String(name ?? '').trim();
  if (!card || !personaName) return '';

  const tagline = extractSectionLines(card, /^##\s*1\.2\s+一句话定位/m, 2);
  const traits = extractSectionLines(card, /^##\s*2\.1\s+性格标签/m, 3);
  const banned = extractSectionLines(card, /^##\s*3\.5b\s+口头禅与禁语/m, 8);
  const bounds = extractSectionLines(card, /^##\s*4\.3\s+边界与底线/m, 3);

  // 三个关键段全空 ⇒ 摘要没有价值，让调用方回退完整卡
  if (!traits.length && !banned.length && !bounds.length) return '';

  const parts = [`【本群人格：${personaName}】（不是默认人格，别混用默认人格的称呼和口癖）`];
  if (tagline.length) parts.push(tagline.join(' '));
  if (traits.length) parts.push(`性格：${traits.join(' / ')}`);
  if (banned.length) parts.push(`禁语/不做：${banned.join(' / ')}`);
  if (bounds.length) parts.push(`雷区：${bounds.join(' / ')}`);
  parts.push('（完整人格卡已在会话开头注入；这里只是身份提醒，不要复述这段）');

  let text = parts.join('\n');
  if (text.length > COMPACT_MAX_CHARS) {
    text = text.slice(0, COMPACT_MAX_CHARS - 1) + '…';
  }
  return text;
}

/** 完整 overlay 文本（首次注入用）。 */
export function buildFullOverlay(cardText, name) {
  return `【本群人格覆盖】\n本群当前人格为「${name}」。全局默认人格层在本群作废；以下人格层优先；安全规则、权限、18+ 边界不变。禁止混用默认人格的名字、称呼和口癖。\n\n${String(cardText ?? '')}`;
}
