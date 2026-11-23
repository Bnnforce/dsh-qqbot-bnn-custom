/**
 * overlay-detect — 判断人格覆盖块是否还活在本会话上下文里（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块
 *
 *  проблемы：
 *   非默认人格（比安安/GPT）现在**每轮都注入完整人格卡 14KB**，实测：
 *     · 示例群A：14 步 → 注入 14 次 → 平均 6.8s
 *     · 示例群B（默认人格）：162 步 → 注入 1 次 → 平均 3.1s
 *   慢 2.2 倍，注入量差 12.7 倍。
 *
 * 为什么不能简单改成"只注入一次"：
 *   `dsh-compaction-basic` 压缩时只保留 **node 0 的 system/message** + 尾部 16% 原文
 *   （DEFAULT_RETAIN_RATIO = .16）。我们的 overlay 是 `role:'user'`，
 *   一旦被卷进折叠范围就**彻底消失** → 人格掉回默认。
 *
 * 正确做法：
 *   **查会话 surface，看 overlay 还在不在；不在了才注入。**
 *   —— 这和群守则判重（session-manager.js）用的是同一套已验证机制。
 *
 * ⚠️ 关键坑（实测踩过，写在这里防止后人再踩）：
 *   **不能用 `decision.messages` 判断！** 那是"本步从收件箱取出的新消息"，
 *   不是"发给模型的完整上下文"（见 dsh-agent runtime-types 注释）。
 *   必须在 `agent.session.surface.nodes` + `agent.session.eventAt` 上查。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** overlay 消息的 source.kind（与 persona-group-overlay.mjs 写入端保持唯一口径）。 */
export const OVERLAY_SOURCE_KIND = 'qqbot:persona-overlay';

/**
 * 判断本会话的 surface 里是否还有指定人格的 overlay。
 *
 * @param {object} agent    宿主 agent 对象（payload.agent）
 * @param {string} persona  人格名；传空则匹配任意人格的 overlay
 * @returns {boolean}       true = overlay 还在（不需要注入）
 *
 * 失败一律返回 false（宁可多注一次，也不要人格丢失）。
 */
export function overlayAlive(agent, persona) {
  try {
    const nodes = agent?.session?.surface?.nodes;
    const eventAt = agent?.session?.eventAt;
    if (!Array.isArray(nodes) || typeof eventAt !== 'function') return false;

    const want = String(persona ?? '').trim();
    for (const seq of nodes) {
      let ev;
      try { ev = eventAt.call(agent.session, seq); } catch { continue; }
      if (!ev) continue;
      const src = ev?.data?.source;
      if (src?.kind !== OVERLAY_SOURCE_KIND) continue;
      // 传了 persona 就要求匹配；不传则任意 overlay 都算
      if (!want) return true;
      if (String(src?.persona ?? '').trim() === want) return true;
    }
  } catch { /* 任何异常 → 当作不存在 */ }
  return false;
}

/**
 * 统计 surface 里 overlay 的份数（诊断用；正常应恒为 0 或 1）。
 *
 * @param {object} agent
 * @param {string} persona
 * @returns {{ total: number, mine: number }}
 */
export function countOverlays(agent, persona) {
  const out = { total: 0, mine: 0 };
  try {
    const nodes = agent?.session?.surface?.nodes;
    const eventAt = agent?.session?.eventAt;
    if (!Array.isArray(nodes) || typeof eventAt !== 'function') return out;
    const want = String(persona ?? '').trim();
    for (const seq of nodes) {
      let ev;
      try { ev = eventAt.call(agent.session, seq); } catch { continue; }
      const src = ev?.data?.source;
      if (src?.kind !== OVERLAY_SOURCE_KIND) continue;
      out.total += 1;
      if (!want || String(src?.persona ?? '').trim() === want) out.mine += 1;
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * 退化判据：surface 拿不到时的兜底（例如宿主版本变化）。
 *
 * 用「上一轮见过的 overlay 是否已被挤出可见窗口」粗判 —— 但因为没有可信的
 * 全量上下文视图，这里**一律返回 false**（= 需要注入），保持旧行为。
 *
 * 单独提出来是为了让调用方一眼看出"这是降级路径"，而不是散落各处。
 */
export function overlayAliveFallback() {
  return false;
}
