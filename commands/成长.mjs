/**
 * 成长 — 看她这段时间的变化（R7 Stage 4）
 *
 * 只读呈现，绝不改角色卡。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { deltaOf, isSignificant } from '../lib/persona-evolution/metrics.mjs';

async function say(ctx, md) {
  const caps = ctx?.caps ?? ctx;
  if (typeof caps?.markdown === 'function') {
    try { if (await caps.markdown(md)) return ''; } catch { /* */ }
  }
  return md;
}

const METRICS = join(EXT_DATA, 'persona-evolution', 'metrics.jsonl');
const MILESTONES = join(EXT_DATA, 'persona-evolution', 'milestones.json');

export default {
  name: ['成长', 'chengzhang', 'growth'],
  description: '看她这段时间的变化（只读）',
  usage: '/成长',

  async handler(ctx) {
    let snapshots = [];
    try {
      if (existsSync(METRICS)) {
        snapshots = readFileSync(METRICS, 'utf8')
          .split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      }
    } catch { /* */ }

    if (snapshots.length < 2) {
      return await say(ctx, [
        '## 🌱 她的变化',
        '',
        '还在观察中。',
        '',
        `（目前攒了 ${snapshots.length} 次记录，至少需要 2 次才能看出趋势）`,
        '这个要慢慢来，几周后才看得出来。',
      ].join('\n'));
    }

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const d = deltaOf(first, last);
    const lines = ['## 🌱 她的变化', ''];

    if (isSignificant(d)) {
      lines.push('说话方式');
      if (Math.abs(d.avgLen) > 3) lines.push(`· 平均句长 ${d.avgLen > 0 ? '变长' : '变短'}了 ${Math.abs(d.avgLen).toFixed(1)} 字`);
      if (Math.abs(d.questionRate) > 0.05) lines.push(`· 提问${d.questionRate > 0 ? '变多' : '变少'}了`);
      if (Math.abs(d.emojiRate) > 0.05) lines.push(`· 表情用得${d.emojiRate > 0 ? '更多' : '更少'}了`);
      lines.push('');

      if (Math.abs(d.moodAvg) > 0.05 || Math.abs(d.variance) > 0.03) {
        lines.push('情绪');
        if (Math.abs(d.moodAvg) > 0.05) lines.push(`· 整体${d.moodAvg > 0 ? '更明朗' : '更沉静'}了`);
        if (Math.abs(d.variance) > 0.03) lines.push(`· 起伏${d.variance < 0 ? '变小了，更稳' : '变大了'}`);
        lines.push('');
      }
    } else {
      lines.push('这段时间没什么明显变化。');
      lines.push('');
    }

    // 里程碑
    try {
      if (existsSync(MILESTONES)) {
        const m = JSON.parse(readFileSync(MILESTONES, 'utf8'));
        const hits = Array.isArray(m?.hits) ? m.hits : [];
        if (hits.length) {
          const LABEL = {
            'first-proactive': '第一次主动开口',
            '100-replies': '回复满 100 条',
            'first-diary': '写了第一篇日记',
            '30-days': '陪了你一个月',
          };
          lines.push('里程碑');
          for (const h of hits) lines.push(`· ${LABEL[h] || h}`);
          lines.push('');
        }
      }
    } catch { /* */ }

    lines.push('（这些只是记录，我不会自己改性格）');
    return await say(ctx, lines.join('\n'));
  },
};
