/**
 * /抽 —— 参与唤醒抽奖 + 查图鉴（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 两个子命令合在一个文件里（共享懒加载与配置）：
 *
 *   /抽          参与抽奖（需要她已留下邀请）
 *   /抽奖图鉴     看本群图鉴收集进度
 *
 * 为什么用命令而不是纯卡片：
 *   命令能拿到完整 ctx（含 openid / scope），实现最简单；
 *   卡片另有一份（botplay/wake-lottery.mjs），两条路都通。
 *
 * 契约注意
 *   · 命令 handler 返回 { kind:'text', content } 才会回复
 *   · 不要在这里做长任务（语音/歌合成可能 5-10 秒，要设超时）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { EXT_ROOT } from '../lib/pack-paths.mjs';

/** 懒加载核心。 */
async function core() {
  return import(join(EXT_ROOT, 'lib', 'wake-lottery', 'index.mjs') + '?c=' + Date.now());
}

/** 从命令 ctx 取群号。 */
function gidOf(ctx) {
  const raw = ctx?.message?.group?.openid
    ?? ctx?.message?.groupId
    ?? ctx?.group?.openid
    ?? ctx?.scope?.id
    ?? ctx?.peerId
    ?? ctx?.caps?.peerId
    ?? '';
  return String(raw ?? '').trim();
}

/** 从命令 ctx 取 openid。 */
function openidOf(ctx) {
  return String(
    ctx?.user?.openid
    ?? ctx?.message?.sender?.openid
    ?? ctx?.caps?.user?.openid
    ?? '',
  ).trim();
}

/** 从命令 ctx 取昵称。 */
function nameOf(ctx) {
  return String(ctx?.user?.name ?? ctx?.message?.senderName ?? '').trim();
}

/** 回复文本。 */
function reply(text) {
  return { kind: 'text', content: String(text ?? '') };
}

export default {
  name: ['抽', 'draw', 'chou', '抽奖图鉴', 'atlas'],
  description: '参与唤醒抽奖 / 查看抽奖图鉴',
  usage: '/抽 ｜ /抽奖图鉴',

  async handler(ctx) {
    const C = await core();
    const cfg = C.loadRuntimeConfig();

    // ── 图鉴分支 ──
    const raw = String(ctx?.command?.raw ?? ctx?.message?.content ?? '').trim();
    const isAtlas = /图鉴|atlas/i.test(raw);
    const gid = gidOf(ctx);
    const openid = openidOf(ctx);

    if (!gid || !openid) return reply('这里用不了（拿不到群号或你的身份）。');

    if (!cfg.enabled) return reply('抽奖还没开呢。');

    if (isAtlas) {
      const a = C.readAtlasFor(gid, openid, cfg);
      return reply(a.text);
    }

    // ── 抽奖分支 ──
    const state = C.readState(gid);
    if (!state.pendingInvite) return reply('现在没有盒子可抽。等她下次醒来吧。');

    const r = await C.executeDraw({
      gid,
      openid,
      name: nameOf(ctx),
      cycleId: state.pendingInvite.cycleId,
      cfg,
      consumeInvite: true,
    });

    if (!r.ok) {
      if (r.reason === 'user-daily-cap') {
        return reply(`今天你已经抽过 ${cfg.perUserDailyCap} 次了，明天再来。`);
      }
      return reply('盒子是空的……下次吧。');
    }

    return reply(r.resultText);
  },
};
