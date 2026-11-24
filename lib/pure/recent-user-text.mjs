/**
 * recent-user-text — 最近一条用户消息的缓冲（供语义召回当查询词用）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要
 *
 *   R6.2 的语义召回要「按用户说了什么」去检索记忆。
 *   但整条召回链路（`buildInjection` → `sources.getMemoryRecall()`）**只传
 *   groupId / userId，拿不到消息正文**。
 *
 *   所以在这里补一层：入站时把每个群最近一条用户消息记下来，
 *   召回时按群取。
 *
 * ── 设计（照抄 recent-media 的成熟模式）──────────────────────────────────
 *
 *   · **进程内 Map + globalThis Symbol**：不落盘、重启即清空
 *   · 每群只留**最近 1 条**（不需要历史，检索只关心"刚才说了什么"）
 *   · 超时自动失效（默认 5 分钟）—— 太久之前的消息不该影响当前召回
 *   · **只记群聊**：私聊没有跨群隔离问题，但召回本来就只在群里用
 *
 * ── 为什么不用文件
 *
 *   这条数据每秒可能变一次，落盘纯属浪费；而且它只是"检索的提示"，
 *   丢了最多是召回退化成空（有兜底），不会丢记忆。
 * ═══════════════════════════════════════════════════════════════════════════
 */

const KEY = Symbol.for('qqbot.recent-user-text.v1');

/** 默认有效期：5 分钟。太久的消息不该影响当前召回。 */
export const MAX_AGE_MS = 5 * 60 * 1000;

/** 最多跟踪多少个群（防内存泄漏）。 */
const MAX_PEERS = 200;

/** 单条文本上限（召回只需要关键词，不需要全文）。 */
const MAX_CHARS = 300;

function buffer() {
  let m = globalThis[KEY];
  if (!(m instanceof Map)) { m = new Map(); globalThis[KEY] = m; }
  return m;
}

/** 从 ctx 里取群 ID。只认群聊。 */
function groupOf(ctx) {
  const scope = String(ctx?.peer?.scope ?? ctx?.scope ?? '');
  if (scope && scope !== 'group') return '';
  const m = ctx?.message ?? {};
  const p = ctx?.peer ?? {};
  return String(
    p.peerId || p.groupId || m.groupOpenid || m.groupId || ctx?.replyTarget?.targetId || '',
  ).trim();
}

/** 从 ctx 里取正文。 */
function textOf(ctx) {
  const m = ctx?.message ?? {};
  return String(ctx?.text ?? m.content ?? m.text ?? ctx?.content ?? '').trim();
}

/**
 * 记一条用户消息（入站时调）。
 *
 * @param {object} ctx inbound 上下文
 * @param {number} [now]
 * @returns {boolean} 是否记住
 */
export function remember(ctx, now = Date.now()) {
  try {
    const gid = groupOf(ctx);
    if (!gid) return false;
    const text = textOf(ctx);
    if (!text) return false;

    const map = buffer();
    // 超限时清掉最旧的一批（Map 保持插入顺序）
    if (map.size >= MAX_PEERS && !map.has(gid)) {
      const drop = Math.ceil(MAX_PEERS / 4);
      let i = 0;
      for (const k of map.keys()) {
        if (i >= drop) break;
        map.delete(k);
        i += 1;
      }
    }
    map.set(gid, { text: text.slice(0, MAX_CHARS), at: now });
    return true;
  } catch {
    return false;
  }
}

/**
 * 取某个群最近一条用户消息（召回时调）。
 *
 * @param {string} gid
 * @param {number} [now]
 * @returns {string} 文本；过期或没有 → 空串
 */
export function recentTextOf(gid, now = Date.now()) {
  try {
    const key = String(gid ?? '').trim();
    if (!key) return '';
    const hit = buffer().get(key);
    if (!hit) return '';
    if (now - Number(hit.at || 0) > MAX_AGE_MS) {
      buffer().delete(key);
      return '';
    }
    return String(hit.text ?? '');
  } catch {
    return '';
  }
}

/** 清空（测试用）。 */
export function clearAll() {
  try { buffer().clear(); } catch { /* ignore */ }
}

export default { remember, recentTextOf, clearAll, MAX_AGE_MS };
