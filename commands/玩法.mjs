/**
 * /玩法 —— 玩法列表卡入口（2026-11-17）
 *
 * 打开「玩法」卡片（botplay/playground.mjs），列全部可玩内容，点按钮直接进。
 *
 * ⚠️ 命令上下文的群号字段是 ctx.caps.peerId（不是 ctx.event.peerId），
 *    已踩过坑；这里用 lib/pure/card-kit.mjs 里验证过的 fireCard。
 */
import { fireCard } from '../lib/pure/card-kit.mjs';

export default {
  name: ['玩法', 'play', 'wanfa', 'games'],
  description: '看能玩什么：签到、抽签、猜拳、骰子、日历、小店…',
  usage: '/玩法',

  async handler(ctx) {
    // 首选：发玩法卡
    if (await fireCard(ctx, 'playground')) return '';
    // 降级：卡片系统不可用时给文字清单（含 markdown → 必须走 markdown 通道）
    const md = [
      '## 🎮 玩法',
      '',
      '**【积分】**',
      '· 签到　每天 +5',
      '· 抽签　按星级发积分',
      '· 猜拳　赢 +2 / 输 −1',
      '· 骰子　每次 +1',
      '· 小店　用积分买吃的',
      '· 排行榜　本群谁分最多',
      '',
      '**【工具】**',
      '· 日历　公历、农历、节气',
      '· 来张图　随机一张',
      '· 随心配　随机配对',
      '',
      '（卡片版发不出来，先看这个清单）',
    ].join('\n');

    const caps = ctx?.caps ?? ctx;
    if (typeof caps?.markdown === 'function') {
      try {
        const ok = await caps.markdown(md);
        if (ok) return '';
      } catch { /* 落到返回文本 */ }
    }
    return md;
  },
};