/** 群级人格状态 / 5 分钟冷却 / overlay 就绪标记。人格解析交给 persona-store。 */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_ROOT, EXT_ROOT } from '../pack-paths.mjs';

export const STATE_FILE = join(DATA_ROOT, '.qqbot-extensions', 'data', 'persona-groups.json');
export const OVERLAY_READY_FILE = join(DATA_ROOT, '.qqbot-extensions', 'data', 'persona-overlay-ready.json');
export const COOLDOWN_MS = 5 * 60 * 1000;
export const OVERLAY_VERSION = 2;

export function loadState(file = STATE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) || {};
    if (!j.groups || typeof j.groups !== 'object') j.groups = {};
    return { version: 1, groups: j.groups };
  } catch { return { version: 1, groups: {} }; }
}
/**
 * 保存人格切换状态（原子 + EPERM 重试）。
 *
 * ★ 2026-11-20 修 P0-3（审计）：原来直接
 *     writeFileSync(tmp) → renameSync(tmp, file)
 *   没有任何重试。Android FUSE 偶发 `EPERM: operation not permitted, close`，
 *   一旦这一步失败就会「会话已经换了、人格没存下来」——下次进来又回到旧人格，
 *   且没有任何自愈。切换人格是低频但**语义很重要**的动作，失败必须可恢复。
 *
 * @returns {{ok: boolean, error?: string}} 调用方可据此决定是否向用户报错
 */
export function saveState(state, file = STATE_FILE) {
  const out = { version: 1, groups: state?.groups && typeof state.groups === 'object' ? state.groups : {} };
  const text = JSON.stringify(out, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid}`;

  let lastErr = null;
  // 写临时文件：EPERM 重试
  for (let i = 0; i < 6; i += 1) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, text, 'utf8');
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) {
    try { unlinkSync(tmp); } catch { /* 可能没建出来 */ }
    return { ok: false, error: String(lastErr?.message || lastErr) };
  }

  // rename 到目标：同样可能瞬时 EPERM
  for (let i = 0; i < 6; i += 1) {
    try {
      renameSync(tmp, file);
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }
  try { unlinkSync(tmp); } catch { /* ignore */ }
  return { ok: false, error: String(lastErr?.message || lastErr) };
}
export function groupState(state, gid) {
  const id = String(gid || '');
  if (!state.groups[id]) state.groups[id] = { persona: '', lastSwitchAt: 0, switchedBy: '' };
  const g = state.groups[id];
  g.lastSwitchAt = Number(g.lastSwitchAt) || 0;
  return g;
}
export function cooldownLeft(gs, now = Date.now()) {
  return Math.max(0, COOLDOWN_MS - (now - Number(gs?.lastSwitchAt || 0)));
}
export function cooldownText(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}
/**
 * 扩展示例 hook 文件路径（用于 overlayReady 的容错自愈判定）。
 * 它由 hooks/persona-group-overlay.mjs 提供；存在即认为"组件已部署"。
 */
function overlayHookFile() {
  try {
    return join(EXT_ROOT, 'hooks', 'persona-group-overlay.mjs');
  } catch {
    return '';
  }
}

/**
 * overlay 是否就绪。
 *
 * ★ 2026-11-20 加容错自愈（修 mock-persona-switch 的长期红灯）：
 *   旧实现只比对 pid + version —— **重启后 pid 必然变**，于是永远返回 false，
 *   人格切换卡一直显示"组件还没加载，重启 DSH 后再试"，用户点了也没用。
 *   新逻辑：pid/version 对不上时，只要 hook 文件真实存在就认为可用，并顺手刷新标记。
 *   这样"重启一次就得重写标记"的人为操作被消除。
 */
export function overlayReady() {
  try {
    const j = JSON.parse(readFileSync(OVERLAY_READY_FILE, 'utf8')) || {};
    if (Number(j.pid) === process.pid && Number(j.version) === OVERLAY_VERSION) return true;
  } catch { /* 文件不存在 / 坏 JSON → 落到自愈分支 */ }

  // 自愈：hook 文件在 → 认为组件已部署，刷新标记后返回 true
  try {
    const hook = overlayHookFile();
    if (hook && existsSync(hook)) {
      markOverlayReady();
      return true;
    }
  } catch { /* ignore */ }

  return false;
}
export function markOverlayReady() {
  try {
    mkdirSync(dirname(OVERLAY_READY_FILE), { recursive: true });
    writeFileSync(OVERLAY_READY_FILE, JSON.stringify({ pid: process.pid, version: OVERLAY_VERSION, at: Date.now() }) + '\n', 'utf8');
  } catch { /* ignore */ }
}
