/**
 * workspace-attach-current — 把 QQBot 的群/私聊会话挂到 Bot 工作区。
 * 插件自身 attach 存在“会话头尚未落盘”的竞态，部分新会话会落 Ungrouped；
 * 这个 hook 在每个 QQ 回合补挂一次（幂等，成功过就跳过）。
 */
export const name = 'workspace-attach-current';

/**
 * 已挂载过的 sessionId 集合（幂等缓存：挂成功就跳过，避免每回合重复走 registry）。
 *
 * 2026-11-02 修无界增长：旧版是裸 `Set`，只加不删 —— QQ 群/私聊会话越开越多，
 * 进程跑一个月就攒下成千上万条，纯内存泄漏（每条 sid ≈ 36 字节 + Set 开销）。
 * 现在包成有界 LRU：超过 `ATTACHED_MAX` 条就淘汰最久未用的；
 * 淘汰只会让已挂过的会话**多走一次幂等 attach**（`ws.attachSession` 本身幂等），
 * 不会造成功能退化。
 */
const ATTACHED_MAX = 500;
const attached = new Map(); // sid -> 最近一次使用时间

function markAttached(sid) {
  const now = Date.now();
  attached.delete(sid); // 重新插入到 Map 尾部（最近使用）
  attached.set(sid, now);
  while (attached.size > ATTACHED_MAX) {
    const oldest = attached.keys().next().value;
    if (oldest === undefined) break;
    attached.delete(oldest);
  }
}

function isAttached(sid) {
  if (!attached.has(sid)) return false;
  markAttached(sid); // 命中即刷新（近似 LRU）
  return true;
}

/** 调试/测试用：清空缓存。 */
export function resetAttachedCache() { attached.clear(); }

/** 调试/测试用：当前缓存条数。 */
export function attachedCount() { return attached.size; }

function qqRecord(agent) {
  try {
    const ch = agent?.ctx?.get?.('qqChannel');
    const mgr = ch?.manager;
    const rec = mgr?.findByAgent?.(agent) || (agent?.session?.id ? mgr?.findBySessionId?.(agent.session.id) : undefined);
    if (!rec || (rec.scope !== 'group' && rec.scope !== 'c2c')) return null;
    return { rec, manager: mgr };
  } catch { return null; }
}

export async function attachCurrent(agent, rootCtx, { force = false } = {}) {
  const q = qqRecord(agent);
  if (!q) return false;
  const sid = String(agent?.session?.id || q.rec.sessionId || '');
  if (!sid) return false;
  if (!force && isAttached(sid)) return false;
  const cwd = String(q.manager?.config?.cwd || process.cwd());
  try {
    const reg = rootCtx?.get?.('workspaceRegistry') || agent?.ctx?.get?.('workspaceRegistry');
    if (!reg?.create) return false;
    const ws = await reg.create(cwd);
    if (!ws?.attachSession) return false;
    await ws.attachSession(sid);
    markAttached(sid);
    return true;
  } catch { return false; }
}

export async function run(env) {
  const ctx = env?.ctx;
  if (!ctx?.on) return 'no-ctx';
  const handler = async (payload, next) => {
    const decision = await next();
    try { await attachCurrent(payload?.agent, ctx); } catch { /* 不影响回复 */ }
    return decision;
  };
  const off = ctx.on('agent/pre-step', handler, { prepend: true });
  try { env?.registerDispose?.(() => { try { if (typeof off === 'function') off(); } catch { /* ignore */ } }); } catch { /* ignore */ }
  return 'ok(workspace attach)';
}
export function dispose() { /* registered via ctx */ }
export default { name: 'workspace-attach-current', run, dispose };
