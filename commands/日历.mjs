/**
 * /日历 —— 日历卡片入口（2026-11-17 用 card-kit 重构）
 *
 * ★ 行为：**发 botplay 卡片**（botplay/calendar.mjs），带功能按钮。
 *
 * ★ 重构点（对照旧版 90 行）：
 *   · loadBotplay() / nsOf() / triggerBotplay 样板 → 统一走 `card-kit.fireCard()`
 *   · 保留降级：botplay 不可用时直接发 markdown 文本
 *
 * ★ 降级为什么必须留：botplay 事件被删/插件没启动时，/日历 不能变成"报错"。
 */
import { buildCalendarText } from '../lib/pure/calendar.mjs';
import { fireCard, commandPeer } from '../lib/pure/card-kit.mjs';

/** 降级：直接发 markdown 文本。 */
async function fallbackText(ctx) {
  const body = buildCalendarText();
  const { uid } = commandPeer(ctx);
  const clean = String(uid || '').trim();
  const text = clean && /^[A-Za-z0-9_-]+$/.test(clean) ? `<@${clean}>\n\n${body}` : body;
  const caps = ctx?.caps ?? ctx ?? {};
  if (typeof caps.markdown === 'function') {
    try {
      const ok = await caps.markdown(text);
      if (ok) return '';
    } catch { /* 落到返回文本 */ }
  }
  return text;
}

export default {
  name: ['日历', 'rili', 'calendar'],
  description: '查今天是什么日子：公历、农历、干支、星座、节日、节气',
  usage: '/日历',

  async handler(ctx) {
    // 首选：卡片
    if (await fireCard(ctx, 'calendar')) return '';
    // 降级：文本（保证任何时候都能用）
    try {
      return await fallbackText(ctx);
    } catch (e) {
      return `日历暂时算不出来：${e instanceof Error ? e.message : String(e)}`;
    }
  },
};