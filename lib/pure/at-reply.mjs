/**
 * at-reply — 群聊命令/卡片回复的 @ 回显小工具
 *
 * 入站扩展直发消息不经过 outbound 的 ensure-at-back；命令触发者被 @ 时
 * 各扩展用这个 helper 在正文/卡片开头补 `<@senderId>`。
 * 只有「群聊 + 平台确实 @ 了我」才补；私聊/裸命令/已带 @ 不重复补。
 */
export function senderIdOf(ctx) {
  return String(
    ctx?.message?.senderId ??
    ctx?.sender ??
    ctx?.caps?.user?.openid ??
    ctx?.user?.openid ??
    '',
  );
}

export function mentionPrefix(ctx) {
  if (String(ctx?.scope ?? ctx?.message?.kind ?? '') !== 'group') return '';
  if (ctx?.platform?.mentioned !== true) return '';
  const id = senderIdOf(ctx);
  if (!id) return '';
  return `<@${id}>`;
}

/** 普通 @昵称（排除邮件 a@b.com 这类） */
const PLAIN_AT_RE = /(?<![\w.%+-])@[\w\u4e00-\u9fa5]/u;

/**
 * 给正文/卡片补 @。避免破坏 markdown 标题：如果文本以 `#` 开头，
 * 把 @ 插到第一行标题之后；普通正文直接放最前。
 * 已有蓝 @ `<@id>` 或普通 `@昵称` 时不重复补（2026-10-22 修 @ 重复）。
 */
export function withAtBack(ctx, text) {
  const s = String(text ?? '');
  if (!s) return s;
  // 已有蓝 @ 或普通 @昵称 → 都不再补
  if (/<@[^>]+>/.test(s)) return s;
  if (PLAIN_AT_RE.test(s)) return s;
  const at = mentionPrefix(ctx);
  if (!at) return s;
  if (s.startsWith('#')) {
    const nl = s.indexOf('\n');
    if (nl >= 0) return `${s.slice(0, nl + 1)}${at} ${s.slice(nl + 1)}`;
    return `${s} ${at}`;
  }
  return `${at} ${s}`;
}

export default { senderIdOf, mentionPrefix, withAtBack };
