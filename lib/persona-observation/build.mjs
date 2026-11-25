/**
 * persona-observation/build — 「人格观察报告」纯函数构建器（缺口 6：人格不会长大）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么存在
 *
 *   她有八维情绪，每天都有 mood-history 快照，但只看单点看不出"人格在长"。
 *   每 2 周出一份**只读**观察报告，对比区间首尾快照 + 主动频率 + 关系远近，
 *   让主人看到趋势、而不是被一堆数值淹没。
 *
 * ── 为什么是纯函数、绝不调 LLM ───────────────────────────────────────────
 *
 *   这份报告是**统计汇总 + 模板化文字**：输入数据已由调用方（从 mood-history
 *   每日快照、接话台账、pair-relations）准备好，本模块只负责排版成 Markdown。
 *   调 LLM 会让成本不为零、结果不可控，违背本报告"零成本、可复现"的定位。
 *   所以本文件：
 *
 *     · 无任何 import（node:fs / 网络 / 宿主 LLM 服务统统不碰）
 *     · 无 Date.now()、无 Math.random()、无 IO —— 同样输入必得同样输出
 *     · 纯同步函数，同步返回字符串
 *
 * ── 铁律 ──────────────────────────────────────────────────────────────────
 *
 *   ① 脱敏：输入里 pairs[].a / pairs[].b 是 openid，**绝不原样写进输出**。
 *      连 AAA/BBB 这类占位符也不写，一律用"有两位群友"这种代称。
 *   ② 只读：报告末尾固定一行声明——只记录观察，不自动改角色卡。
 *   ③ 永不抛错：坏输入返回一份能看的最小报告，而不是把调用方一起带崩。
 *
 * ── 与 weekly-report（好感度周报）的区别 ──────────────────────────────────
 *
 *   那是"她对你什么态度"（熟识度/好感度），本报告是"她这个人本身在怎么变"
 *   （情绪走势 / 主动程度 / 关系远近）。两者数据源不同、结论不同，不要混。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 趋势判定阈值：区间首尾差超过它才算「上升/下降」，否则视作「平稳」。 */
const EPS = 0.03;
/** 单点倾向阈值：与中性 0.5 的差超过它才算「有倾向」（与 /状态 命令一致）。 */
const DEVIATION = 0.12;

/**
 * 可观察的关键维度（8 维取关键几维即可）。
 * label：给主人看的维度名；up/down/flat：首尾对比的人话；
 * hi/lo：只有单点快照时，按 0~1 值给的人话。
 */
const DIMS = [
  { key: 'mood',       label: '心情', up: '心情比之前更好了', down: '心情比之前更闷了', flat: '心情平稳',   hi: '心情不错', lo: '有点闷' },
  { key: 'energy',     label: '精力', up: '精神比之前更足了', down: '比之前更累了',     flat: '精力平稳',   hi: '精神好',   lo: '有点累' },
  { key: 'composure',  label: '从容', up: '更放松从容了',       down: '比之前更紧绷了',   flat: '从容度平稳', hi: '很放松',   lo: '有点紧张' },
  { key: 'connection', label: '交流', up: '更愿意交流了',       down: '比之前更想安静了', flat: '交流欲平稳', hi: '想说话',   lo: '想安静' },
];

/** 安全转数字；非有限数返回 null。 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 安全取字符串；非字符串或空串返回兜底值。 */
function str(v, fallback) {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/** 首尾对比一行：`→ 平稳 —— 心情平稳`。任一端缺值返回 null。 */
function trendLine(a, b, dim) {
  const x = num(a);
  const y = num(b);
  if (x == null || y == null) return null;
  const d = y - x;
  if (d > EPS) return `↑ 上升 —— ${dim.up}`;
  if (d < -EPS) return `↓ 下降 —— ${dim.down}`;
  return `→ 平稳 —— ${dim.flat}`;
}

/** 单点状态一行（只有 end 时用）。值缺返回 null。 */
function stateLine(v, dim) {
  const n = num(v);
  if (n == null) return null;
  if (n > 0.5 + DEVIATION) return dim.hi;
  if (n < 0.5 - DEVIATION) return dim.lo;
  return '平稳';
}

/** 情绪走势节。缺 end 时整节跳过；缺 start 时只写 end 当前状态。 */
function buildMoodSection(mood) {
  const m = mood && typeof mood === 'object' ? mood : null;
  if (!m) return [];
  const start = m.start && typeof m.start === 'object' ? m.start : null;
  const end = m.end && typeof m.end === 'object' ? m.end : null;
  if (!end) return []; // 连结束快照都没有 → 跳过情绪节

  const lines = ['## 情绪走势', ''];

  if (start) {
    for (const dim of DIMS) {
      const line = trendLine(start[dim.key], end[dim.key], dim);
      if (line) lines.push(`- ${dim.label}：${line}`);
    }
    if (lines.length === 2) lines.push('（快照里没有可对比的维度。）');
  } else {
    lines.push('（区间起始快照缺失，以下为区间末快照的当前状态。）');
    for (const dim of DIMS) {
      const line = stateLine(end[dim.key], dim);
      if (line) lines.push(`- ${dim.label}：${line}`);
    }
  }

  const samples = num(m.samples);
  if (samples != null && samples >= 0) lines.push('', `（观察了 ${samples} 个每日快照。）`);
  return lines;
}

/** 主动程度节。activity 缺省或没 proactiveCount 时整节跳过。 */
function buildActivitySection(activity) {
  const a = activity && typeof activity === 'object' ? activity : null;
  if (!a) return [];
  const c = num(a.proactiveCount);
  if (c == null) return [];

  const lines = ['## 主动程度', ''];
  const days = num(a.days);
  const tail = (days != null && days > 0) ? `（观察 ${days} 天）` : '';
  if (c > 0) lines.push(`这段时间她主动开口 ${c} 次${tail}。`);
  else lines.push(`这段时间她没有主动开口${tail}。`);
  return lines;
}

/**
 * 关系变化节。pairs 为空 → 写"没有明显关系变化"。
 * ⚠️ 脱敏：这里只读 interactions 计数，**绝不读、更绝不写** p.a / p.b。
 */
function buildRelationSection(pairs) {
  const arr = Array.isArray(pairs) ? pairs.filter((p) => p && typeof p === 'object') : [];
  const lines = ['## 关系变化', ''];
  if (!arr.length) {
    lines.push('这段时间没有明显的关系变化。');
    return lines;
  }
  lines.push(`这段时间有 ${arr.length} 对群友走得更近了：`);
  for (const p of arr) {
    const n = num(p.interactions);
    const tail = (n != null && n > 0) ? `（累计互动 ${n} 次）` : '';
    lines.push(`- 有两位群友走得更近了${tail}`);
  }
  return lines;
}

/**
 * 生成一份人格观察报告（Markdown 字符串）。
 *
 * @param {object} input 结构化观察数据（由调用方从已有数据准备）。
 *   - from/to：观察区间 YYYY-MM-DD
 *   - persona：人格名
 *   - mood：{ start, end, samples }，start/end 为 { mood, energy, composure, connection, ... }
 *   - activity：{ proactiveCount, days }，可缺省 null
 *   - pairs：[{ a, b, interactions }]，a/b 为 openid，可缺省 []
 * @returns {string} Markdown 报告。任何坏输入都返回最小报告，绝不抛错。
 */
export function buildObservation(input) {
  try {
    const src = input && typeof input === 'object' ? input : {};
    const persona = str(src.persona, '未命名人格');
    const from = str(src.from, '—');
    const to = str(src.to, '—');

    const lines = [`# 人格观察 · ${persona} · ${from} ~ ${to}`, ''];

    const sections = [
      buildMoodSection(src.mood),
      buildActivitySection(src.activity),
      buildRelationSection(src.pairs),
    ];

    let wrote = false;
    for (const sec of sections) {
      if (!sec || !sec.length) continue;
      if (wrote) lines.push('');
      lines.push(...sec);
      wrote = true;
    }
    if (!wrote) lines.push('（观察数据不完整，暂无可写的观察内容。）');

    lines.push('');
    lines.push('本报告只记录观察，不自动改角色卡。要不要采纳由主人决定。');
    return lines.join('\n') + '\n';
  } catch {
    // 永不抛错：任何意外都落到最小报告
    return [
      '# 人格观察 · 未命名人格 · — ~ —',
      '',
      '（观察数据异常，无法生成报告。）',
      '',
      '本报告只记录观察，不自动改角色卡。要不要采纳由主人决定。',
      '',
    ].join('\n');
  }
}

export default { buildObservation };
