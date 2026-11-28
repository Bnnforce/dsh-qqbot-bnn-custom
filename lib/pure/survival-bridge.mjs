/**
 * survival-bridge — 让扩展包用上插件的生存机制（R10，2026-11-29）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么需要这层桥：
 *
 *   锚点(anchor) / 刹车(circuit-breaker) / 生存体检(survival) 写在插件
 *   dsh-bnnbotbox 里（那里有 persona 上下文）。
 *
 *   但造物任务是扩展包（bnn-custom）的 hook。
 *   扩展包的运行时副本不能 import 插件里的文件（路径不定、可能没装）。
 *
 *   所以这里做两件事：
 *     ① 先试着从插件目录加载（装了插件就用插件版）
 *     ② 加载不到就用本地简化版（保证不崩）
 *
 *   ★ 原则：**永远不因为「生存机制加载失败」而阻塞造物。**
 *     保护机制坏掉，也不能让她停摆。
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 可能的插件路径 */
function pluginPaths() {
  const home = process.env.DSH_HOME || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';
  return [
    join(home, 'plugins', 'dsh-bnnbotbox', 'lib', 'persona', 'r4'),
    '/sdcard/DSH/.repos/dsh-bnnbotbox/lib/persona/r4',
  ];
}

/** 尝试加载插件的 survival 模块 */
async function loadSurvival() {
  for (const base of pluginPaths()) {
    const p = join(base, 'survival.js');
    if (!existsSync(p)) continue;
    try {
      const m = await import('file://' + p);
      if (typeof m.survivalBrief === 'function' && typeof m.canActNow === 'function') {
        return m;
      }
    } catch { /* 试下一个 */ }
  }
  return null;
}

// ── 本地简化版（插件不在时的兜底）────────────────────────────────────────────

/** 读刹车状态（简化版：只读 frozen 标记） */
function localBrake(stateDir) {
  try {
    const p = join(stateDir, 'circuit-breaker.json');
    if (!existsSync(p)) return { frozen: false };
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { frozen: j.frozen === true, reason: j.reason || '' };
  } catch {
    return { frozen: false };
  }
}

/** 本地版：能不能动手 */
export function canActNowLocal(stateDir) {
  const b = localBrake(stateDir);
  if (b.frozen) return { canAct: false, reason: b.reason || '停机中' };
  return { canAct: true };
}

/**
 * 能不能动手（优先用插件版）。
 *
 * @param {string} stateDir
 * @returns {Promise<{canAct:boolean, reason?:string}>}
 */
export async function canActNow(stateDir) {
  const m = await loadSurvival();
  if (m) {
    try { return m.canActNow(stateDir); } catch { /* 落到本地版 */ }
  }
  return canActNowLocal(stateDir);
}

/**
 * 生存简报（优先用插件版）。
 *
 * @param {object} opts
 * @returns {Promise<string>}
 */
export async function survivalBrief(opts = {}) {
  const m = await loadSurvival();
  if (m) {
    try { return m.survivalBrief(opts) || ''; } catch { /* 落到本地版 */ }
  }

  // 本地简化版：只报刹车和遗嘱
  const lines = [];
  try {
    const b = localBrake(opts.stateDir);
    if (b.frozen) lines.push('⚠️ 我停着呢：' + (b.reason || '之前连续出错'));
  } catch { /* ignore */ }

  try {
    const p = join(opts.selfDir || '', '主人留给我的话.md');
    if (existsSync(p)) {
      const t = readFileSync(p, 'utf8');
      if (!/（还没写）/.test(t) && t.trim().length >= 100) {
        lines.push('主人留了话（' + t.length + ' 字）。');
      }
    }
  } catch { /* ignore */ }

  if (!lines.length) return '';
  return ['【你现在的状态】', ...lines.map((l) => '  ' + l), ''].join('\n');
}

/**
 * 记录一次改动结果（供 brake 用）。
 *
 * @param {string} stateDir
 * @param {string} result 'success' | 'rollback' | 'fail'
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
export async function recordOutcome(stateDir, result, opts = {}) {
  // 优先用插件版
  const m = await loadSurvival();
  if (m) {
    try {
      // 插件版没有 record（在 circuit-breaker 里），试着单独加载
      for (const base of pluginPaths()) {
        const p = join(base, 'circuit-breaker.js');
        if (!existsSync(p)) continue;
        const cb = await import('file://' + p);
        if (typeof cb.record === 'function') {
          cb.record(stateDir, result, opts);
          return;
        }
      }
    } catch { /* 落本地 */ }
  }

  // 本地简化版：只维护连续回滚计数和冻结
  try {
    const p = join(stateDir, 'circuit-breaker.json');
    let st = { frozen: false, consecutiveRollbacks: 0, history: [] };
    if (existsSync(p)) {
      try { st = { ...st, ...JSON.parse(readFileSync(p, 'utf8')) }; } catch { /* 用默认 */ }
    }

    if (result === 'success') {
      st.consecutiveRollbacks = 0;
    } else {
      st.consecutiveRollbacks = Number(st.consecutiveRollbacks || 0) + 1;
      if (st.consecutiveRollbacks >= 4 && !st.frozen) {
        st.frozen = true;
        st.frozenAt = new Date().toISOString();
        st.reason = '连续回滚 ' + st.consecutiveRollbacks + ' 次';
      }
    }

    st.history = [...(st.history || []), {
      at: new Date().toISOString(),
      event: result,
      ...(opts.failKind ? { kind: String(opts.failKind).slice(0, 40) } : {}),
    }].slice(-50);

    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    writeFileSync(p, JSON.stringify(st, null, 2) + '\n', 'utf8');
  } catch { /* 记录失败不阻塞 */ }
}

export default { canActNow, survivalBrief, recordOutcome };
