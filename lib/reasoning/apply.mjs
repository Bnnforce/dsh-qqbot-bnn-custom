/**
 * reasoning/apply — 把决策应用到 agent（2026-11-18）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与 decide.mjs 的分工：
 *   decide.mjs  —— 纯函数，回答"该不该改、改成什么"
 *   apply.mjs   —— 副作用隔离，真正写 agent.options 并记日志
 *
 * 为什么分开：
 *   决策逻辑是 bug 高发区（本次就修了一个），必须 100% 可单测；
 *   而写 agent.options 无法脱离宿主对象，只能集成测。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { decide } from './decide.mjs';

/**
 * 把决策结果写回 agent.options（**原地替换引用**）。
 *
 * 为什么必须换新对象：宿主每回合 `prepareRequest` 读 `agent.options`，
 * 直接 mutate 在某些适配器下不会触发重算；换引用最稳。
 *
 * @param {object} agent
 * @param {object} result decide() 的返回值
 * @returns {boolean} 是否真的写了
 */
export function writeOptions(agent, result) {
  if (!result?.changed) return false;
  try {
    const next = { ...(agent.options || {}) };
    if (result.provider !== undefined) next.provider = result.provider;
    if (result.model !== undefined) next.model = result.model;
    if (result.effort !== undefined) next.reasoningEffort = result.effort;
    agent.options = next;
    return true;
  } catch {
    return false;
  }
}

/**
 * 决策 + 应用（组合函数）。
 *
 * @param {object} agent
 * @param {object} input   同 decide() 的输入（agent 由本函数注入）
 * @param {object} [logger]
 * @returns {'set'|'already'|'skip'}
 */
export function applyToAgent(agent, input, logger) {
  let r;
  try {
    r = decide({ ...input, agent });
  } catch {
    return 'skip';          // 决策异常 → 绝不影响主链
  }

  if (!r?.changed) return r?.skip ? 'skip' : 'already';

  const ok = writeOptions(agent, r);
  if (!ok) return 'skip';

  try {
    logger?.info?.(`[reasoning] ${String(agent?.id ?? '?').slice(0, 8)}: ${r.reason}`);
  } catch { /* 日志失败不影响 */ }

  return 'set';
}