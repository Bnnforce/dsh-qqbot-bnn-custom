// botplay 事件：日历（2026-11-09 新增卡片版）
//
// 主人要求：日历也要做成卡片，卡片下面同样有别的功能按钮。
//   → 原先 /日历 只是发一条 markdown 文本（没有按钮），
//     所以从别的卡片点「📅 日历」跳到日历后，就**卡在一条没有按钮的消息上**，回不去。
//   现在日历本身是一张卡片，底部有 骰子 / 抽签 / 来张图 三个功能按钮（不含日历自己）。
//
// 数据来源：lib/calendar.mjs 的 buildCalendarText()（**唯一真相源**）。
//   /日历 命令与这张卡片共用同一个函数，保证两处输出逐字一致。
//
// 按钮设计：
//   · 没有「再来一次」这类主按钮 —— 日历一天只有一种，重复点不会变（跟抽签改成
//     「一天一种」同一个道理：留一个点了没变化的按钮会让人以为坏了）。
//   · 唯一的主按钮是「🔄 刷新」（跨天时会变），次要按钮是三个功能入口。
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withClickerMention } from '../lib/pure/card-format.mjs';
import { navButtons, handleNavClick } from '../lib/pure/card-nav.mjs';
import { DATA_ROOT, EXT_ROOT } from '../lib/pack-paths.mjs';


async function lib(ctx) {
  // 带版本参数：热重载时避免命中旧的模块缓存（与 random-image 同一做法）
  return import(pathToFileURL(join(EXT_ROOT, 'lib', 'pure', 'calendar.mjs')).href + '?evt=' + Date.now());
}

function setCard(ctx, text, buttons) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}

/** 日历卡片的按钮：刷新 + 功能按钮（不含日历自己）。 */
function calendarButtons() {
  return [
    { id: 'refresh', label: '🔄 刷新', style: 1, botAction: { type: 'reply_text', text: '' } },
    ...navButtons('calendar'),
  ];
}

/** 生成日历正文并刷新卡片。 */
async function render(ctx) {
  const L = await lib(ctx);
  let body = '';
  try {
    body = L.buildCalendarText(new Date());
  } catch (e) {
    body = `# 📅 日历\n\n今天算不出来：${e?.message ?? e}`;
  }
  // ★ 全局：@操作者 单独一行 + 空行，再给 markdown 正文
  setCard(ctx, withClickerMention(ctx, body), calendarButtons());
  return body;
}

export default {
  name: '日历',

  async onInit(ctx) {
    await render(ctx);
    ctx.card().dirty = false;
  },

  async onClick(ctx, info) {
    const btn = String(info.buttonId || '');

    // ★ 功能按钮（骰子/抽签/来张图）：直接调用对应功能的现有实现，本卡不变形
    const nav = await handleNavClick(ctx, btn);
    if (nav !== undefined) return nav;

    // 刷新（跨天/改完文件后看一眼）
    if (btn === 'refresh') {
      await render(ctx);
      ctx.card().dirty = true;
      return '';
    }
    return;
  },
};
