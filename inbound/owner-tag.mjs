/**
 * owner-tag — 给主人的消息打「★主人」标记（2026-10-18 修「不认识人」）
 *
 * 背景：人设里写着「主人消息会被系统打 ★主人 前缀」，`groupAdmin.owners` 白名单也配了，
 * 但插件其实**从来没实现过这个标记** —— 结果她在私聊/群里把你当普通群友：
 * 「人家哪知道你是谁」「人设只有我主人能改」，拒绝按主人的话改人设。
 *
 * 做法：早挂点 onInbound 判 `ctx.isOwner`（= 发送者 openid 在 owners 白名单里），
 * 命中就用 `ctx.rewrite()` 在正文开头加一行「★主人」。
 *  - 只加一次（已有标记不重复加）；
 *  - 私聊、群聊都生效；
 *  - 纯图片消息也加（正文为空时只留标记，身份照样能认）。
 */
export const name = 'owner-tag';

const MARK = '★主人';

/** 消息开头的 @ 标记（可能连续多个） */
const MENTION_PREFIX = /^(\s*<@[^>]+>)+\s*/;

export async function onInbound(ctx, next) {
  try {
    if (ctx.isOwner) {
      const text = String(ctx.text ?? '');
      const stripped = text.replace(MENTION_PREFIX, '').trimStart();
      // ⚠️ 斜杠命令（/bot-new 等）必须保持「以 / 开头」：
      //   ① 不加 ★主人 前缀；② 顺手剥掉 @ 前缀（"@bot /cmd" 否则也解析不到）。
      //   （2026-10-18 实测：/bot-new 被模型"假装"执行，会话其实没换。）
      const cmdText = stripped.replace(/^／/, '/');
      if (cmdText.startsWith('/')) {
        if (stripped !== text) ctx.rewrite({ text: cmdText, reason: '命令去 @ 前缀/全角斜杠归一' });
      } else if (!text.startsWith(MARK)) {
        ctx.rewrite({ text: text ? `${MARK}\n${text}` : MARK, reason: '主人身份标记' });
      }
    }
  } catch {
    /* 标记失败不影响消息 */
  }
  return next();
}
