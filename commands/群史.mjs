/**
 * 群史 — 看这个群一起经历过什么（R7 Stage 1）
 *
 * 用法：
 *   /群史          看编年史（没有就提示还在攒）
 *   /群史 事件     看事件账本（最近 10 条）
 */
import { readChronicle, readEvents } from '../lib/chronicle/store.mjs';
import { commandPeer } from '../lib/pure/card-kit.mjs';

async function say(ctx, md) {
  const caps = ctx?.caps ?? ctx;
  if (typeof caps?.markdown === 'function') {
    try { if (await caps.markdown(md)) return ''; } catch { /* 落回文本 */ }
  }
  return md;
}

function fmtDate(ms) {
  const d = new Date(Number(ms) || 0);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default {
  name: ['群史', 'qunshi', 'chronicle'],
  description: '这个群一起经历过什么',
  usage: '/群史 [事件]',

  async handler(ctx) {
    const { gid } = commandPeer(ctx);
    if (!gid) return await say(ctx, '这个命令只能在群里用。');

    const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();

    // ── 事件账本 ──
    if (/^(事件|events?)$/i.test(raw)) {
      const events = readEvents(gid);
      if (!events.length) {
        return await say(ctx, [
          '## 📜 群史事件',
          '',
          '还没有够格成为「共同记忆」的事件。',
          '',
          '（需要 3 人以上、聊满 30 分钟、有情绪高点的那种）',
        ].join('\n'));
      }
      const lines = ['## 📜 群史事件', ''];
      for (const e of events.slice(-10).reverse()) {
        const people = Array.isArray(e.participants) ? e.participants.length : 0;
        lines.push(`· ${fmtDate(e.startAt)}　${people} 人　${e.msgCount || 0} 条`);
      }
      lines.push('', `（共 ${events.length} 条）`);
      return await say(ctx, lines.join('\n'));
    }

    // ── 编年史 ──
    const text = readChronicle(gid);
    if (!text || !String(text).trim()) {
      const events = readEvents(gid);
      return await say(ctx, [
        '## 📜 群史',
        '',
        events.length
          ? `我还在攒。目前记下了 ${events.length} 件事，等攒够了再写成长篇。`
          : '我还在攒。这个群还没有够格成为「共同记忆」的事。',
        '',
        '（要一起经历过一些事，才写得出来呀）',
      ].join('\n'));
    }

    return await say(ctx, String(text));
  },
};
