/**
 * 徽章 — 这个群被贴了什么标签（R7 Stage 5）
 *
 * 全部从群自己的历史统计得出，零 LLM。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { computeBadges, renderBadges, groupStats, MIN_SAMPLES } from '../lib/group-badge/compute.mjs';
import { commandPeer } from '../lib/pure/card-kit.mjs';

async function say(ctx, md) {
  const caps = ctx?.caps ?? ctx;
  if (typeof caps?.markdown === 'function') {
    try { if (await caps.markdown(md)) return ''; } catch { /* */ }
  }
  return md;
}

function loadMessages(gid) {
  // 优先长期存档
  const dirs = [
    join(EXT_DATA, 'msg-archive', `group_${gid}`),
    join(EXT_DATA, '..', '..', '.qqbot', 'msg-history', `group_${gid}`),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
      const out = [];
      for (const f of files) {
        try {
          const raw = readFileSync(join(dir, f), 'utf8');
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line)); } catch { /* */ }
          }
        } catch { /* */ }
      }
      if (out.length) return out;
    } catch { /* */ }
  }
  return [];
}

export default {
  name: ['徽章', 'huizhang', 'badge'],
  description: '这个群的标签（统计得出）',
  usage: '/徽章',

  async handler(ctx) {
    const { gid } = commandPeer(ctx);
    if (!gid) return await say(ctx, '这个命令只能在群里用。');

    const msgs = loadMessages(gid);
    if (msgs.length < MIN_SAMPLES) {
      return await say(ctx, [
        '## 🏅 群徽章',
        '',
        `还没攒够。目前 ${msgs.length} 条，至少需要 ${MIN_SAMPLES} 条。`,
      ].join('\n'));
    }

    const badges = computeBadges(msgs);
    const stats = groupStats(msgs);

    if (!badges.length) {
      return await say(ctx, [
        '## 🏅 群徽章',
        '',
        '这个群很特别——没有哪个标签特别突出。',
        '',
        `（统计了 ${stats.total} 条消息）`,
      ].join('\n'));
    }

    const lines = ['## 🏅 群徽章', '', renderBadges(badges), ''];
    for (const b of badges) lines.push(`· ${b.label} —— ${b.desc}`);
    lines.push('', `（统计了 ${stats.total} 条消息 / ${stats.days} 天）`);
    return await say(ctx, lines.join('\n'));
  },
};
