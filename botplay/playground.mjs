/**
 * botplay/playground — 玩法列表卡（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计目标（主人要求）：
 *   「把玩法专门做一个卡片触发，就是玩法列表，然后按钮写玩法触发」
 *   → 一张"入口卡"，列出所有能玩的玩法，点按钮就打开对应卡片。
 *
 * ★ 走官方方案（关键）：
 *   · 卡片接口：export default { name, onInit, onClick }（docs/botplay-contract.md）
 *   · 用户身份：ctx.user（不是自己翻 ctx.event）
 *   · 跨卡片跳转：复用 lib/pure/card-nav.mjs 的 runNav()
 *     它内部就是官方 triggerBotplay（features/botplay.js）——
 *     与 dice.mjs / calendar.mjs 的"功能按钮"完全同一套机制。
 *   · dirty：只在真要刷新按钮状态时才置 true
 *
 * ★ 为什么不用 navButtons()：
 *   navButtons 是"在任意卡片底部加一排互跳按钮"，每张卡都有。
 *   而本卡是**独立的入口卡**，它本身就是全部玩法列表，
 *   所以不需要再挂 nav 那 4 个按钮（会重复）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { runNav } from '../lib/pure/card-nav.mjs';

/**
 * 玩法清单（**唯一真相源**）。
 *
 * 想加/删玩法只改这里 —— 按钮、文案、顺序全跟着走。
 * eventId 必须与 botplay-events.json 里的 id 一致。
 */
export const GAMES = [
  {
    key: 'checkin',
    eventId: 'daily-checkin',
    label: '📅 签到',
    desc: '每天 +5 积分',
    tag: '积分',
  },
  {
    key: 'fortune',
    eventId: 'fortune',
    label: '🎴 抽签',
    desc: '按星级发积分（最高 +5）',
    tag: '积分',
  },
  {
    key: 'rps',
    eventId: 'rps',
    label: '✊ 猜拳',
    desc: '赢 +2 / 输 −1，每天 5 次',
    tag: '积分',
  },
  {
    key: 'dice',
    eventId: 'dice',
    label: '🎲 骰子',
    desc: '每次 +1，每天 5 次',
    tag: '积分',
  },
  {
    key: 'calendar',
    eventId: 'calendar',
    label: '📅 日历',
    desc: '公历、农历、节气',
    tag: '工具',
  },
  {
    key: 'image',
    eventId: 'random-image',
    label: '🖼 来张图',
    desc: '随机一张',
    tag: '工具',
  },
  {
    key: 'pairing',
    eventId: 'pairing',
    label: '💞 随心配',
    desc: '随机配对',
    tag: '工具',
  },
  {
    key: 'shop',
    eventId: 'shop',
    label: '🏪 小店',
    desc: '用积分买点吃的',
    tag: '积分',
  },
  {
    key: 'points-board',
    eventId: 'points-board',
    label: '📊 排行榜',
    desc: '本群谁分最多',
    tag: '积分',
  },
];

/** 每行几个按钮（QQ 键盘上限 5×3=15，本卡 9 个安全）。 */
const BUTTONS_PER_ROW = 3;

/** 兜底按钮：卡片没有按钮会被 QQ 拒发。 */
const FALLBACK_BUTTONS = [
  { id: 'play:0', label: '📅 签到', style: 1, botAction: { type: 'reply_text', text: '' } },
];

function setCard(ctx, text, buttons = []) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}

/** 渲染玩法列表正文。 */
export function renderPlaygroundText(games = GAMES) {
  const lines = ['## 🎮 玩法', ''];
  const groups = new Map();
  for (const g of games) {
    const k = String(g.tag || '其他');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(g);
  }
  for (const [tag, list] of groups) {
    lines.push(`**【${tag}】**`);
    for (const g of list) {
      lines.push(`· ${g.label.replace(/^\S+\s/, '')}　${g.desc}`);
    }
    lines.push('');
  }
  lines.push('点下面的按钮进去玩。');
  return lines.join('\n').trimEnd();
}

/** 生成按钮（index 是 GAMES 下标，回调里按 index 找，避免 id 过长）。 */
export function buildGameButtons(games = GAMES) {
  return games.map((g, i) => ({
    id: `play:${i}`,
    label: g.label,
    style: 1,
    botAction: { type: 'reply_text', text: '' },
  }));
}

export default {
  name: '玩法',

  async onInit(ctx) {
    setCard(ctx, renderPlaygroundText(GAMES), buildGameButtons(GAMES));
    // first render 不需要 dirty（框架首刷就是这张卡）
  },

  async onClick(ctx, info) {
    const btn = String(info?.buttonId || '');
    if (!btn.startsWith('play:')) return '';

    const idx = Number(btn.slice(5));
    const game = GAMES[idx];
    if (!game) return '';

    // ★ 官方方案：复用 runNav 的 triggerBotplay 跨卡片跳转
    try {
      const nav = await runNav(ctx, {
        key: game.key,
        label: game.label,
        eventId: game.eventId,
      });
      if (nav === '') return '';   // 卡片已发出
      if (nav) return nav;         // 有错误信息 → 回给点击者
      return '';
    } catch (e) {
      return `「${game.label}」打开失败：${e instanceof Error ? e.message : String(e)}`;
    }
  },
};