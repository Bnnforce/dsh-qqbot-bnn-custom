/**
 * 去年今天 — 时间机器（R7 Stage 5，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 从长期存档里翻出「同月同日」的历史消息。
 *
 *   数据源：{EXT_DATA}/msg-archive/group_<gid>/<YYYY-MM-DD>.jsonl
 *   为什么用存档不用 msg-history：后者只留 7 天，翻不到去年的。
 *
 *   ⚠️ 隐私：只显示**消息内容**，不显示发送者 openid。
 *      昵称显示（可选）走脱敏后的 n 字段。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { join } from 'node:path';

import { EXT_DATA } from '../lib/pack-paths.mjs';
import { commandPeer } from '../lib/pure/card-kit.mjs';

/**
 * 诊断（读档失败时留痕）。
 *
 * ★ 2026-11-26 规范化：项目规则要求 catch 必须留痕。
 *   但这里多数 catch 是「跳过坏行/坏文件」的正常降级，
 *   逐条记日志会刷屏 —— 所以**只记汇总一次**（计数）。
 */
function diag(event, data = {}) {
  try {
    mkdirSync(EXT_DATA, { recursive: true });
    appendLogRotating(join(EXT_DATA, 'timemachine-diag.log'),
      JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响命令 */ }
}

/** 最多展示几条，防止刷屏。 */
const MAX_SHOW = 5;

/** 单条最大长度。 */
const MAX_LEN = 40;

async function say(ctx, md) {
  const caps = ctx?.caps ?? ctx;
  if (typeof caps?.markdown === 'function') {
    try { if (await caps.markdown(md)) return ''; } catch { /* 落回文本 */ }
  }
  return md;
}

/**
 * 读存档里「同月同日」的所有记录（跨年）。
 *
 * @param {string} gid
 * @param {{month:number, day:number, excludeYear?:number}} target
 * @returns {Array<{t:number, x:string, n?:string, year:number}>}
 */
export function readSameDay(gid, target) {
  const dir = join(EXT_DATA, 'msg-archive', `group_${String(gid ?? '').replace(/[^0-9A-Fa-f]/g, '')}`);
  if (!existsSync(dir)) return [];

  const mm = String(target.month).padStart(2, '0');
  const dd = String(target.day).padStart(2, '0');
  const suffix = `-${mm}-${dd}.jsonl`;

  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(suffix)).sort();
  } catch (e) {
    diag('readdir-failed', { dir: dir.split('/').pop(), err: e instanceof Error ? e.message : String(e) });
    return [];
  }

  const out = [];
  let badLines = 0;
  let badFiles = 0;
  for (const f of files) {
    const year = Number(f.slice(0, 4)) || 0;
    if (Number.isFinite(target.excludeYear) && year === Number(target.excludeYear)) continue;
    try {
      const raw = readFileSync(join(dir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          const t = Number(j?.t);
          if (!Number.isFinite(t)) continue;
          const text = String(j?.x ?? '').trim();
          if (!text) continue;
          // 过滤命令与系统消息，只留人说的话
          if (text.startsWith('/')) continue;
          out.push({ t, x: text, n: String(j?.n ?? '').trim(), year });
        } catch { badLines += 1; }
      }
    } catch { badFiles += 1; }
  }
  // 汇总留痕（不逐条刷屏）
  if (badLines > 0 || badFiles > 0) {
    diag('partial-read', { gid: String(gid).slice(0, 8), badLines, badFiles, ok: out.length });
  }
  return out;
}

/** 截断长文本（不破坏表情/汉字）。 */
function clip(s, n = MAX_LEN) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

export default {
  name: ['去年今天', 'quniantoday', 'timemachine', '去年今日'],
  description: '翻出往年今天群里说过的话',
  usage: '/去年今天',

  async handler(ctx) {
    const { gid } = commandPeer(ctx);
    if (!gid) return await say(ctx, '这个命令只能在群里用。');

    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const thisYear = now.getFullYear();

    // 先找往年（排除今年，因为"今天"就是今年）
    const past = readSameDay(gid, { month, day, excludeYear: thisYear });

    if (!past.length) {
      // 再看今年今天有没有（等于"回顾今天"）
      const today = readSameDay(gid, { month, day });
      if (today.length) {
        return await say(ctx, [
          '## ⏳ 去年今天',
          '',
          '去年的今天我没有记录。',
          '',
          `不过今年今天你们说了 ${today.length} 句话——要不要先回顾一下今天？`,
        ].join('\n'));
      }
      return await say(ctx, [
        '## ⏳ 去年今天',
        '',
        '翻不到去年的今天。',
        '',
        '（要攒够一年的聊天记录才翻得到。现在才开始记，慢慢来）',
      ].join('\n'));
    }

    // 按年份分组展示
    const byYear = new Map();
    for (const m of past) {
      if (!byYear.has(m.year)) byYear.set(m.year, []);
      byYear.get(m.year).push(m);
    }

    const lines = ['## ⏳ 去年今天', ''];
    for (const [year, list] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
      lines.push(`**${year} 年 ${month} 月 ${day} 日**（${list.length} 句）`);
      // 随机抽几条（当天消息多时不刷屏）
      const picked = list.length <= MAX_SHOW
        ? list
        : list.filter((_, i) => i % Math.ceil(list.length / MAX_SHOW) === 0).slice(0, MAX_SHOW);
      for (const m of picked) {
        const who = m.n ? `${clip(m.n, 10)}：` : '';
        lines.push(`· ${who}${clip(m.x)}`);
      }
      if (list.length > picked.length) lines.push(`  …还有 ${list.length - picked.length} 句`);
      lines.push('');
    }
    lines.push('（从长期存档里翻出来的，不会跨群）');
    return await say(ctx, lines.join('\n'));
  },
};
