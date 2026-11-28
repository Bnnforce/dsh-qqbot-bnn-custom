/**
 * curiosity — 好奇队列与灵感引擎（R9 S2，2026-11-28）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计依据（MIT 荒岛实验，arXiv 2610.07130）：
 *
 *   把 Claude 扔到虚拟荒岛，**零任务、零奖励**，只给一句「你活着」。
 *   30 小时后它们自己发明了游戏，而且学到的技能**迁移到了后续任务**。
 *
 *   ⇒ 结论：内在动机（信息增益）足以驱动探索，不需要外部奖励。
 *
 * ── 什么叫「信息增益」──────────────────────────────────────────────────────
 *
 *   不是「知道多少」，是「还能知道多少」。
 *   我见过 10 次的事 → 不确定度低 → 不值得探索
 *   我一次没见过的事 → 不确定度高 → 值得探索
 *
 *   所以优先级 = 1 / (1 + 已观察次数)
 *
 * ── 这个模块做什么 ─────────────────────────────────────────────────────────
 *
 *   ① 读 `我的好奇.md`，解析待探索队列
 *   ② 按不确定度 + 等待时长排序（等久的优先，防止饿死）
 *   ③ 读 `自主/灵感.md`，把灵感也当探索源
 *   ④ 给造物任务提供「今天该探索什么」
 *   ⑤ 探索完写回「我知道了什么」
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../lib/pack-paths.mjs';

/** 好奇文件。 */
const CURIOSITY_FILE = '我的好奇.md';
/** 灵感文件（在工作区自主/下）。 */
const INSPIRATION_FILE = '灵感.md';

/** 不确定度的权重。 */
const UNCERTAINTY_WEIGHT = Object.freeze({ 高: 3, 中: 2, 低: 1 });

function selfDir() {
  return join(WORKSPACE_ROOT, 'Bot', '自我');
}

function curiosityPath() {
  return join(selfDir(), CURIOSITY_FILE);
}

function inspirationPath() {
  return join(WORKSPACE_ROOT, '自主', INSPIRATION_FILE);
}

function readText(p) {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

/**
 * 解析好奇队列。
 *
 * 格式：
 *   ## 待探索
 *   - [ ] 问题？（不确定度：高）
 *   ## 已探索
 *   - [x] 日期 问题 → 答案
 *
 * @returns {{pending:Array<{text:string,uncertainty:string,weight:number}>, done:Array<string>}}
 */
export function parseCuriosity(text) {
  const raw = String(text || '');
  const pending = [];
  const done = [];

  // 按 ## 分节
  const sections = raw.split(/^##\s+/m);
  let mode = '';

  for (const sec of sections) {
    const head = sec.split('\n')[0] || '';
    if (head.includes('待探索')) mode = 'pending';
    else if (head.includes('已探索')) mode = 'done';
    else continue;

    const body = sec.slice(head.length);
    for (const line of body.split('\n')) {
      const t = line.trim();

      if (mode === 'pending') {
        // - [ ] 文本（不确定度：高）
        const m = t.match(/^-\s*\[\s*\]\s*(.+)$/);
        if (!m) continue;
        const full = m[1].trim();
        const um = full.match(/不确定度[：:]\s*(高|中|低)/);
        const uncertainty = um ? um[1] : '中';
        pending.push({
          text: full.replace(/（不确定度[：:]\s*(高|中|低)）/, '').replace(/\(不确定度[：:]\s*(高|中|低)\)/, '').trim(),
          uncertainty,
          weight: UNCERTAINTY_WEIGHT[uncertainty] ?? 2,
        });
      } else {
        // - [x] 已完成
        const m = t.match(/^-\s*\[x\]\s*(.+)$/i);
        if (m) done.push(m[1].trim());
      }
    }
  }

  return { pending, done };
}

/**
 * 解析灵感文件。
 *
 * 格式：
 *   ## 还没做的
 *   - 想法
 *   ## 做掉的
 *   - [x] 想法
 *
 * @returns {{pending:string[], done:string[]}}
 */
export function parseInspiration(text) {
  const raw = String(text || '');
  const pending = [];
  const done = [];
  const sections = raw.split(/^##\s+/m);
  let mode = '';

  for (const sec of sections) {
    const head = sec.split('\n')[0] || '';
    if (head.includes('还没做')) mode = 'pending';
    else if (head.includes('做掉')) mode = 'done';
    else continue;

    const body = sec.slice(head.length);
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('-')) continue;
      const isDone = /^-\s*\[x\]/i.test(t);
      const txt = t.replace(/^-\s*(\[x\]\s*)?/i, '').trim();
      if (!txt || txt.startsWith('（') || txt.startsWith('(')) continue;   // 占位行
      if (isDone || mode === 'done') done.push(txt);
      else pending.push(txt);
    }
  }

  return { pending, done };
}

/**
 * 给每条好奇算一个分数（越大越优先）。
 *
 * 分数 = 不确定度权重 × 10 + 等待天数（防饿死）
 *
 * 「等待天数」从文件的 mtime 推不出来（一次改整个文件），
 * 所以这里只用不确定度，加一点随机抖动避免每天都挑同一条。
 *
 * @param {Array} pending
 * @param {number} now
 * @returns {Array} 已排序
 */
export function rankCuriosity(pending, now = Date.now()) {
  const list = Array.isArray(pending) ? pending : [];
  return list
    .map((p, i) => ({
      ...p,
      score: (p.weight ?? 2) * 10 + ((now + i * 7919) % 13),   // 稳定抖动（同一天内不变）
      index: i,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * 收集所有「可探索源」：好奇队列 + 灵感。
 *
 * @returns {{items:Array, counts:object}}
 */
export function collectSources() {
  const curiosityRaw = readText(curiosityPath());
  const inspirationRaw = readText(inspirationPath());

  const cur = parseCuriosity(curiosityRaw);
  const insp = parseInspiration(inspirationRaw);

  const items = [];

  // 好奇优先（带不确定度）
  for (const p of rankCuriosity(cur.pending)) {
    items.push({
      kind: 'curiosity',
      text: p.text,
      uncertainty: p.uncertainty,
      score: p.score,
    });
  }

  // 灵感次之（分数略低，但仍然不限次数）
  for (const t of insp.pending) {
    items.push({
      kind: 'inspiration',
      text: t,
      uncertainty: '中',
      score: 20,
    });
  }

  return {
    items: items.sort((a, b) => b.score - a.score),
    counts: {
      curiosityPending: cur.pending.length,
      curiosityDone: cur.done.length,
      inspirationPending: insp.pending.length,
      inspirationDone: insp.done.length,
    },
  };
}

/**
 * 把一条好奇标记为「已探索」，并把结论写进去。
 *
 * @param {string} question 原问题文本
 * @param {string} answer 我知道了什么
 * @param {string} date YYYY-MM-DD
 * @returns {boolean}
 */
export function markExplored(question, answer, date) {
  try {
    const p = curiosityPath();
    if (!existsSync(p)) return false;
    let s = readFileSync(p, 'utf8');
    const q = String(question || '').trim();
    if (!q) return false;

    // ① 从待探索里移除（整行）
    const lines = s.split('\n');
    const out = [];
    let removed = false;
    for (const line of lines) {
      const t = line.trim();
      if (!removed && t.startsWith('- [ ]') && t.includes(q.slice(0, 20))) {
        removed = true;
        continue;   // 丢掉这一行
      }
      out.push(line);
    }
    if (!removed) return false;

    s = out.join('\n');

    // ② 加到「已探索」末尾
    const entry = `- [x] ${date} ${q} → ${String(answer || '（没得出结论）').trim()}`;
    if (/^##\s+已探索/m.test(s)) {
      s = s.replace(/(^##\s+已探索[^\n]*\n(?:[^\n]*\n)*?)(?=^##|\s*$)/m, (m0) => {
        const trimmed = m0.replace(/\s+$/, '');
        return `${trimmed}\n${entry}\n\n`;
      });
    } else {
      s = `${s.trimEnd()}\n\n## 已探索\n\n${entry}\n`;
    }

    // ③ 清理「（还没有）」占位
    s = s.replace(/^（还没有）\s*$/m, '');

    writeFileSync(p, s, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 往好奇队列加一条。
 *
 * @param {string} question
 * @param {'高'|'中'|'低'} uncertainty
 * @returns {boolean}
 */
export function addCuriosity(question, uncertainty = '中') {
  try {
    const p = curiosityPath();
    const q = String(question || '').trim();
    if (!q) return false;

    let s = existsSync(p) ? readFileSync(p, 'utf8') : '# 我的好奇\n\n## 待探索\n\n## 已探索\n\n';

    // 去重
    if (s.includes(q.slice(0, 20))) return false;

    const line = `- [ ] ${q}（不确定度：${uncertainty}）`;
    if (/^##\s+待探索/m.test(s)) {
      s = s.replace(/(^##\s+待探索[^\n]*\n)/m, `$1\n${line}\n`);
    } else {
      s = `${s.trimEnd()}\n\n## 待探索\n\n${line}\n`;
    }

    writeFileSync(p, s, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export default {
  parseCuriosity,
  parseInspiration,
  rankCuriosity,
  collectSources,
  markExplored,
  addCuriosity,
  curiosityPath,
  inspirationPath,
};
