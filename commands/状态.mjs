/**
 * 状态 —— 查看她现在的状态（仅主人）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有
 *
 *   她有八维情绪（插件 dsh-bnnbotbox 维护）+ 每日历史快照（R6.4 加的），
 *   但主人没法一眼看到"她现在怎么样"。
 *
 *   本命令读这些数据，输出**人话**（不是数值，避免 OOC），
 *   让主人能了解她的状态、趋势。
 *
 * ── 为什么仅主人 ──────────────────────────────────────────────────────────
 *
 *   情绪是私人的。群友看了没意义，还可能被拿来"逗她"。
 *   与 /memcheck 同级的 owner 门禁。
 *
 * ── 输出原则 ──────────────────────────────────────────────────────────────
 *
 *   · 只给主人看，输出**人话短语**（"有点累""想安静"），
 *     不输出 0~1 数值（数值是内部实现，主人要精确值可读文件）
 *   · 冷启动（样本不足）→ 明说"还没积累够，看不出状态"
 *   · 历史趋势 → 只说"比昨天/上周"的大方向，不罗列数字
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = ['状态', 'status'];

/** 插件数据根（跨体系：扩展包读插件落盘的数据，路径与 slang-inline 同款约定）。 */
function personaDataRoot() {
  // ⚠️ DSH_HOME 已经含 `.dsh`；只有 fallback 到 homedir() 时才拼 `.dsh`
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'data', 'dsh-anti-ai-persona');
}

/** 读当前八维状态（mood-axes.json）。失败返回 null。 */
function readAxes() {
  try {
    const p = join(personaDataRoot(), 'state', 'mood-axes.json');
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** 读历史快照（最近 N 天）。失败返回 []。 */
function readHistory(recentDays = 7) {
  try {
    const dir = join(personaDataRoot(), 'state', 'mood-history');
    if (!existsSync(dir)) return [];
    const out = [];
    for (const f of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
      const date = f.replace(/\.json$/, '');
      // 粗略：只取最近 recentDays 天
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        out.push({ ...j, date });
      } catch { /* 脏文件跳过 */ }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out.slice(-recentDays);
  } catch {
    return [];
  }
}

/** 八维 → 人话短语。0~1，中性 0.5，偏离 >0.12 才算"有倾向"。 */
const PHRASES = {
  mood:       { hi: '心情不错', lo: '有点闷' },
  energy:     { hi: '精神好',   lo: '有点累' },
  connection: { hi: '想说话',   lo: '想安静' },
  composure:  { hi: '很放松',   lo: '有点紧张' },
  closeness:  { hi: '挺亲近',   lo: '有点疏远' },
  patience:   { hi: '有耐心',   lo: '不太耐烦' },
  confidence: { hi: '挺笃定',   lo: '有点犹豫' },
  focus:      { hi: '挺专注',   lo: '有点分心' },
};

const DEVIATION = 0.12;

/** 把一个维度值 → 人话短语；不偏离返回 null。 */
function describeDim(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 0.5 + DEVIATION) return 'hi';
  if (n < 0.5 - DEVIATION) return 'lo';
  return null;
}

function describeAxes(axes) {
  const parts = [];
  for (const [dim, ph] of Object.entries(PHRASES)) {
    const dir = describeDim(axes?.[dim]);
    if (dir) parts.push(ph[dir]);
  }
  return parts;
}

export default {
  name,
  description: '查看她现在的状态（仅主人；人话，不是数值）',
  usage: '/状态 或 /状态 一周',

  async handler(ctx) {
    // 权限：情绪是私人的，只给主人
    const caps = ctx?.caps ?? ctx;
    const owners = Array.isArray(caps?.owners) ? caps.owners : [];
    const isOwner = caps?.user?.isOwner ?? caps?.isOwner ?? ctx?.isOwner;
    if (owners.length && isOwner !== true) return { kind: 'text', content: '这个只给我自己看哦' };

    const arg = String(ctx?.args ?? ctx?.text ?? '').trim();
    const wantHistory = /一周|历史|趋势|最近/.test(arg);

    const axes = readAxes();
    const lines = ['## 她现在的状态', ''];

    // 当前状态
    if (!axes) {
      lines.push('状态文件还没有（插件没启动 / 没积累够）。');
    } else if ((axes.samples ?? 0) < 3) {
      lines.push('刚开始聊，还看不出状态。');
    } else {
      const desc = describeAxes(axes);
      if (desc.length) {
        lines.push(desc.join('，') + '。');
      } else {
        lines.push('挺平稳的，没有特别明显的情绪。');
      }
    }

    // 历史趋势（可选）
    if (wantHistory) {
      const hist = readHistory(7);
      if (hist.length < 2) {
        lines.push('', '（还没有足够的历史快照，多聊几天再看趋势。）');
      } else {
        const first = hist[0];
        const last = hist[hist.length - 1];
        // 简单趋势：比较 mood 和 energy
        const delta = (name, hiWord, loWord) => {
          const a = Number(first[name]);
          const b = Number(last[name]);
          if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
          const d = b - a;
          if (d > 0.12) return `${hiWord}了一点`;
          if (d < -0.12) return `${loWord}了一点`;
          return '没什么变化';
        };
        const moodT = delta('mood', '心情好', '心情闷');
        const energyT = delta('energy', '精神', '累');
        lines.push('', '**最近一周趋势**：');
        if (moodT) lines.push(`- 心情：${moodT}`);
        if (energyT) lines.push(`- 精力：${energyT}`);
        lines.push(`- 快照：${hist.length} 天`);
      }
    }

    // ★ 2026-11-24 修（mock-calendar-and-fortune T7 抓到）：
    //   本命令输出 markdown（`## 标题` / `**加粗**`），必须自己调 caps.markdown()，
    //   否则 QQ 会把 ## 和 ** 原样显示成字面文字。
    const md = lines.join('\n');
    if (typeof caps?.markdown === 'function') {
      try {
        const ok = await caps.markdown(md);
        if (ok) return '';
      } catch { /* 落到返回文本 */ }
    }
    return { kind: 'text', content: md };
  },
};
