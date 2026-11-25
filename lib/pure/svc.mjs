/**
 * svc — 从宿主 ctx 取 cordis 服务（扩展包侧唯一实现）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件（2026-11-25 收敛）
 *
 *   收敛前有 2 套等价实现：
 *     · lib/shop/adapters/llm-host.mjs 的 svcOf —— 覆盖 caps.kernel/kernel/caps/ctx
 *     · commands/会话列表.mjs 的 kernelOf + svcOf —— 带模块级 KERNEL 缓存
 *   两套语义一致但细节不同（一套多覆盖 ctx.caps，一套有缓存），维护时分不清该信谁。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 关键坑（2026-10-14 实测踩过，改代码前必读）
 *
 *   cordis Context 上的 `ctx` / `caps` 等属性是 **getter**，**未 inject 时读取即抛**
 *   （报错 `cannot get property "ctx" without inject`）。
 *
 *   ⇒ 所以**绝不能**把它们放进数组字面量里"顺手取一下"：
 *        for (const v of [ctx.caps, ctx.kernel]) ...   // ❌ 数组字面量会立刻求值，直接抛
 *      必须**逐个包 try** 惰性读取。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么拿不到时返回 undefined 而不是 null
 *
 *   调用方普遍写 `if (!svc)` —— 对 undefined 和 null 都成立。
 *   只有在「按钮回调 / 出站扩展」这类特殊挂点才恒拿不到（上游不给 kernel），
 *   那不是本模块能解决的，调用方须自行降级。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 安全取属性：getter 抛错时返回 undefined，绝不外抛。 */
function safeGet(obj, key) {
  try { return obj?.[key]; } catch { return undefined; }
}

/**
 * 取「内核句柄」（cordis Context）。
 *
 * @param {object} ctx 扩展上下文
 * @returns {any} kernel 句柄；拿不到返回 undefined
 */
export function kernelOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return undefined;
  const caps = safeGet(ctx, 'caps');
  const viaCaps = caps ? safeGet(caps, 'kernel') : undefined;
  if (viaCaps) return viaCaps;
  const direct = safeGet(ctx, 'kernel');
  if (direct) return direct;
  return undefined;
}

/**
 * 从宿主 ctx 取服务（`kernel.get(name)` 主路，多层兜底）。
 *
 * 候选句柄依次：`caps.kernel` → `caps` → `kernel` → `ctx`
 * 每个句柄：先试 `handle.get(name)`，再试 `handle.root/ctx/caps` 下的 get 或属性。
 *
 * @param {object} ctx 扩展上下文
 * @param {string} name 服务名（如 'llm'、'qqChannel'、'sessions'）
 * @returns {any} 服务实例；拿不到返回 undefined（永不抛）
 */
export function svcOf(ctx, name) {
  if (!ctx || typeof ctx !== 'object' || !name) return undefined;

  // 候选句柄。注意：每个都必须经 safeGet 惰性读取，不能用数组字面量直接求值。
  const handles = [];

  // ★ 2026-11-25 修（真 bug，日记永远写占位的根因）：
  //   hook 拿到的 `env.ctx` 通常**本身就是 cordis Context**（自带 .get()）。
  //   旧实现只把 caps.kernel / kernel / ctx.ctx 当句柄，**漏了 ctx 自己** ⇒
  //   svcOf(env.ctx, 'llm') 恒返回 undefined ⇒ 日记永远写「今天没能写成日记」。
  //   参照 hooks/memewiki-adapter.mjs:255 的正确写法：`env.ctx.get('qqChannel')`。
  if (typeof safeGet(ctx, 'get') === 'function') handles.push(ctx);

  const caps = safeGet(ctx, 'caps');
  if (caps) {
    const ck = safeGet(caps, 'kernel');
    if (ck) handles.push(ck);
    handles.push(caps);
  }
  const k = safeGet(ctx, 'kernel');
  if (k) handles.push(k);
  const c = safeGet(ctx, 'ctx');
  if (c) handles.push(c);

  for (const h of handles) {
    // ① 句柄本身有 get
    try {
      if (h && typeof h.get === 'function') {
        const v = h.get(name);
        if (v) return v;
      }
    } catch { /* 继续下一个句柄 */ }
    // ② 句柄下面还有 root / ctx / caps
    for (const key of ['root', 'ctx', 'caps']) {
      try {
        const sub = h?.[key];
        if (!sub) continue;
        const v = typeof sub.get === 'function' ? sub.get(name) : sub[name];
        if (v) return v;
      } catch { /* 继续 */ }
    }
  }
  return undefined;
}

export default { kernelOf, svcOf };
