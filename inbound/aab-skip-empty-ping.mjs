/**
 * aab-skip-empty-ping — 空 @ / 空消息不唤醒 AI
 *
 * 2026-10-23 现象：群里一条只有 <@all> 的空消息把 AI 唤醒，
 * 模型没有当前问题，就抓上一轮“你妈妈是谁”的上下文又答了一遍，
 * 看起来像“记忆混乱/复读”。
 *
 * 规则：去掉 @提及、@全体、★主人、空白/零宽字符后：
 *   · 没文本、也没图片/文件/语音/视频 → 直接 annihilate，不调 next；
 *   · 有文本或媒体 → 正常放行。
 */
export const name = 'skip-empty-ping';

const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff]/g;

function clean(text) {
  return String(text ?? '')
    .replace(/<@[^>]+>/g, '')
    .replace(/@全体成员|@all/gi, '')
    .replace(/★主人/g, '')
    .replace(ZERO_WIDTH, '')
    .trim();
}

function hasMedia(ctx) {
  const m = ctx?.message ?? {};
  const q = ctx?.state?.quote;
  return Boolean(
    m.image || m.imageUrl || m.file || m.fileUrl || m.voice || m.voiceUrl ||
    m.video || m.videoUrl || (Array.isArray(m.attachments) && m.attachments.length) ||
    (Array.isArray(q?.attachments) && q.attachments.length),
  );
}

export async function onInbound(ctx, next) {
  try {
    const scope = String(ctx?.scope ?? '');
    if (scope !== 'group' && scope !== 'c2c') return next();
    if (clean(ctx?.text) || hasMedia(ctx)) return next();
    try {
      await ctx?.annihilate?.({ reason: '空@消息/空文本', ownerAck: true });
    } catch { /* ignore */ }
    return;
  } catch {
    return next();
  }
}
