/**
 * aaa-addressed-command-gate — 群聊斜杠命令也必须先 @ 或叫名字
 *
 * 角色卡 P0G：群聊没被 @、没叫名字（比安安／安安）就不回。
 * 内置命令已有 owner gate；这里补的是“任何群聊斜杠命令”的地址门控：
 *   · 被 @ 或叫名字 → 放行给命令层；
 *   · 否则直接 annihilate，不执行、不回；
 *   · 私聊 c2c 不拦。
 */
export const name = 'addressed-command-gate';

import { addressed } from '../lib/name.mjs';

function commandText(ctx) {
  let s = String(ctx?.text ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trimStart();
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s
      .replace(/^★主人\s*/u, '')
      .replace(/^(?:<@[^>]+>|@[^\s]+)\s*/u, '')
      .replace(/^／/, '/')
      .trimStart();
    if (s === before) break;
  }
  return s;
}

export async function onInbound(ctx, next) {
  try {
    if (String(ctx?.scope ?? '') !== 'group') return next();
    const cmd = commandText(ctx);
    if (!cmd.startsWith('/')) return next();
    if (addressed(ctx)) return next();
    try { await ctx?.annihilate?.({ reason: '群聊命令未 @/叫名字，忽略', ownerAck: false }); } catch { /* ignore */ }
    return;
  } catch { /* ignore */ }
  return next();
}
