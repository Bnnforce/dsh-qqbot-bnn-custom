/**
 * card-format — 卡片正文的统一格式化层（2026-11-09）
 *
 * 主人要求：所有按钮/指令触发的卡片，**先 @ 触发者，再换行发正文**（否则 markdown 格式失效）。
 * 这是**全局功能**，所以抽成一层，六个 botplay 事件共用，而不是各写一份。
 *
 * ── 为什么必须空一行（`\n\n`）────────────────────────────────────────────────
 * QQ 卡片正文走 markdown；`<@openid>` 是**行内标签**，不是块级元素。
 * 如果写成 `<@id> ## 标题`（同一行），QQ 会把 `##` 当普通文本渲染 → 标题失效。
 * 必须让 @ 单独成段、与正文之间空一行，后面的 `##`/`**` 才会被当 markdown 解析。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 *   · 纯函数：无 IO、无 Date.now()、无随机 → 可直接单测
 *   · 任何输入都不抛（脏数据/undefined/null 一律降级为空串）
 *   · 不产生多余空行：@ 为空时正文原样返回，正文为空时只返回 @
 */

/**
 * 拼卡片正文：`@某人` + 空行 + markdown 正文。
 *
 * @param input.mention 已经拼好的 @ 标签（如 `<@ABC123>`）；空串 = 不 @
 * @param input.body    markdown 正文
 * @returns 拼好的正文；两者都空 → 空串
 */
export function formatCardText(input) {
  const m = String(input?.mention ?? '').trim();
  const b = String(input?.body ?? '').trim();
  if (!m && !b) return '';
  if (!m) return b;          // 没 @ → 正文原样（不留空行）
  if (!b) return m;          // 没正文 → 只有 @
  // ★ 关键：@ 独立成段 + 空行，让后面的 markdown 块级元素正常渲染
  return `${m}\n\n${b}`;
}

/**
 * 取「点击者」的 @ 标签。
 *
 * ⚠️ 为什么是**点击者**而不是「触发者」：
 *   上游 `botplay.js` 有个字段名 bug —— `resolveExtCard` 传 `triggererId`，
 *   但 `buildExtCtx` 解构的是 `clickerId`，所以 **onInit（发卡那一刻）拿不到触发者**，
 *   `ctx.user.openid` 恒为空。只有 `onClick`（点击时）能正常拿到。
 *   实测证据见 `维护/全局卡片@触发者-方案-20261109.md`。
 *   所以这里的语义是「当前操作者」，发卡时返回空串（首屏不 @），点击后正常 @。
 *
 * @returns `<@openid>`；拿不到身份 → 空串（调用方据此不 @，也不会留空行）
 */
export function clickerMention(ctx) {
  const uid = String(ctx?.user?.openid ?? '').trim();
  if (!uid) return '';
  // 只允许字母数字：openid 非法字符会让整段 @ 标签失效，甚至破坏 markdown
  if (!/^[A-Za-z0-9_-]+$/.test(uid)) return '';
  return `<@${uid}>`;
}

/**
 * 组合便利函数：直接产出「@点击者 + 正文」。
 *
 * @param ctx  botplay 卡片上下文
 * @param body markdown 正文
 */
export function withClickerMention(ctx, body) {
  return formatCardText({ mention: clickerMention(ctx), body });
}
