/**
 * 翻收藏 — 看悄悄记下的群友金句（R7 Stage 5）
 *
 * ⚠️ 隐私边界：只给主人看。群友敲会被拒。
 */
import { pickRandom, readCollection } from '../lib/group-badge/collection.mjs';
import { commandPeer } from '../lib/pure/card-kit.mjs';

async function say(ctx, md) {
  const caps = ctx?.caps ?? ctx;
  if (typeof caps?.markdown === 'function') {
    try { if (await caps.markdown(md)) return ''; } catch { /* */ }
  }
  return md;
}

/** 判断是不是主人（多种 ctx 形态都认）。 */
function isOwner(ctx) {
  const caps = ctx?.caps ?? ctx ?? {};
  const u = caps?.user ?? ctx?.user ?? {};
  if (u?.isOwner === true) return true;
  const owners = caps?.owners ?? ctx?.owners;
  if (Array.isArray(owners) && owners.length) {
    const me = String(u?.openid ?? caps?.actorOpenid ?? '');
    if (me && owners.map(String).includes(me)) return true;
  }
  return false;
}

export default {
  name: ['翻收藏', 'fanshoucang', 'collection'],
  description: '看她悄悄记下的金句（仅主人）',
  usage: '/翻收藏',

  async handler(ctx) {
    if (!isOwner(ctx)) {
      return await say(ctx, '这个只有主人能看哦。');
    }

    const { gid } = commandPeer(ctx);
    if (!gid) return await say(ctx, '这个命令只能在群里用。');

    const all = readCollection(gid);
    if (!all.length) {
      return await say(ctx, [
        '## 📔 她的收藏',
        '',
        '还什么都没收。',
        '',
        '（要有人说出那种「一句话让人记住」的话，我才会悄悄记下来）',
      ].join('\n'));
    }

    const picked = pickRandom(gid, 3);
    const lines = ['## 📔 她的收藏', ''];
    for (const item of picked) {
      lines.push(`· ${item.text}`);
    }
    lines.push('', `（一共收了 ${all.length} 条）`);
    return await say(ctx, lines.join('\n'));
  },
};
