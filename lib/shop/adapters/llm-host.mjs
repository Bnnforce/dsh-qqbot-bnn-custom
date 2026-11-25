/**
 * shop/adapters/llm-host — 把宿主 LLM 包装成小店的 polish 接口（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要这层包装：
 *   copy-template.mjs 的契约是 `llm.polish(skeleton) → string|null`，
 *   而宿主 llm 服务是 `llm.stream({provider, model, messages})`。
 *   中间差一层：选模型 + 组消息 + 收流 + 超时。
 *
 * ⚠️ 重要约束（实测 2026-10-13）：
 *   `kernel.get('llm')` 在 **handler** 里能拿到，在**按钮回调**里拿不到
 *   （两种 ctx 的 kernel 不是同一个对象）。
 *   所以本适配器**只在定时任务（shop-task）里用**，卡片回调里不要调。
 *
 * ⚠️ 失败必须关闭：任何异常返回 null，调用方用模板原文。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 从 ctx 里逐层找宿主服务。
 *
 * ★★ 2026-11-21 修（真 bug，导致小店润色 + 回忆录叙事**双双永久降级**）：
 *
 *   原实现：
 *
 *     const k = ctx?.caps?.kernel ?? ctx?.caps ?? ctx?.kernel ?? ctx?.ctx ?? ctx;
 *     try { return k?.get?.(name); } catch { return undefined; }
 *
 *   两个致命问题：
 *
 *   ① **cordis Context 上的 `ctx` / `caps` 是 getter，未 inject 时「读取即抛」**
 *      （同一坑在 `commands/会话列表.mjs:335` 记过：`cannot get property "ctx" without inject`）。
 *      原实现把 `ctx?.caps` 放进 **`??` 表达式**里"顺手取一下"——那一步就会抛，
 *      而外层那个 try 只包住了后面的 `k?.get`，**包不住前面的属性读取** ⇒ 直接抛到调用方。
 *
 *   ② 即使不抛，优先取到 `ctx.caps` 本身（能力包对象）再 `.get(name)` 也不对 ——
 *      能力包上没有 get 方法。
 *
 *   正确做法（照抄 `commands/会话列表.mjs:340-357` 已验证的写法）：
 *     逐个候选**单独 try**，先试 `kernel.get(name)`，再试 root/ctx/caps 三个句柄。
 *
 * @param {object} ctx
 * @param {string} name 服务名（如 'llm'）
 * @returns {any} 拿不到返回 undefined
 */
// ★ 2026-11-25：唯一实现已收敛到 lib/pure/svc.mjs，这里 re-export 保持旧调用方兼容。
import { svcOf } from '../../pure/svc.mjs';
export { svcOf };


/** 收集 stream 文本。 */
async function collectStreamText(stream) {
  let out = '';
  for await (const chunk of stream) {
    if (typeof chunk === 'string') { out += chunk; continue; }
    if (chunk && typeof chunk === 'object') {
      if (typeof chunk.text === 'string') out += chunk.text;
      else if (typeof chunk.delta === 'string') out += chunk.delta;
      else if (chunk.delta && typeof chunk.delta.text === 'string') out += chunk.delta.text;
    }
  }
  return out;
}

/** 带超时的收集。 */
async function collectWithTimeout(stream, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__timeout__'), Math.max(1, ms));
    timer.unref?.();
  });
  try {
    const r = await Promise.race([
      collectStreamText(stream).then((t) => ({ text: t })),
      timeout,
    ]);
    if (r === '__timeout__') return null;
    return r.text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 解析默认模型路由（优先 currentModel，退第一个可用）。 */
/**
 * 从返回值里取出数组（兼容两种形态）。
 *
 * ★ 2026-11-21 修（真 bug，影响小店润色 + 回忆录叙事）：
 *
 *   原实现直接 `providers?.[0]` 把返回值当数组用：
 *
 *     const providers = await llm.listProviders();
 *     const first = providers?.[0];
 *
 *   但实测宿主 `@deepseek-ai/dsh-llm/lib/index.js:2028` 的实现是：
 *
 *     listProviders() {
 *       return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
 *     }
 *
 *   —— 返回**裸数组**，不是 `{ok, providers:[...]}` 这种包一层的对象。
 *   所以 `providers?.[0]` 在数组上取到的是第一个 provider 对象本身
 *   （`first.id` 恰好能读到），**这条侥幸能过**；
 *   但 `listModels` 若返回对象就会失败。更关键的是：
 *   一旦某个 provider 没有 id、或返回结构变成对象，整条链就静默返回 undefined
 *   ⇒ narrateLlm 返回 null ⇒ **永远降级到模板**（群里看到机械文案）。
 *
 *   现在两种形态都兼容：数组直接取，对象则取 .providers / .models / .items / .data。
 *
 * @param {unknown} v
 * @returns {any[]}
 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  for (const k of ['providers', 'models', 'items', 'data', 'list']) {
    if (Array.isArray(v[k])) return v[k];
  }
  return [];
}

export async function resolveDefaultRoute(llm) {
  if (!llm) return undefined;
  try {
    const cur = llm.currentModel ?? llm.defaultModel;
    if (cur && typeof cur === 'object') {
      const p = String(cur.provider ?? '').trim();
      const m = String(cur.model ?? cur.id ?? '').trim();
      if (p && m) return { provider: p, model: m };
    }
    const providers = asArray(typeof llm.listProviders === 'function' ? await llm.listProviders() : []);
    const first = providers?.[0];
    if (!first?.id) return undefined;
    const models = asArray(typeof llm.listModels === 'function' ? await llm.listModels(first.id) : []);
    const m0 = models?.[0];
    if (!m0?.id) return undefined;
    return { provider: first.id, model: m0.id };
  } catch {
    return undefined;
  }
}

/**
 * 创建能传给 shop 的 llm 适配器。
 *
 * @param {{ctx:any, logger?:object, timeoutMs?:number}} p
 * @returns {{polish: (skeleton:string, persona:string, opts?:object) => Promise<string|null>}}
 */
export function createHostLlm(p) {
  const logger = p.logger;

  return {
    async polish(skeleton, persona, opts = {}) {
      const llm = svcOf(p.ctx, 'llm');
      if (!llm || typeof llm.stream !== 'function') return null;

      const route = await resolveDefaultRoute(llm);
      if (!route) return null;

      const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 12_000;

      // 极简 prompt：只让它"改成这个角色的口吻"，不许扩写
      const system = [
        '你是润色器。把给定的一句话改成指定的说话口吻。',
        '铁律：',
        '· 只润色，不新增信息；不得改变数字、商品名、金额',
        '· 长度不能超过原文的 1.8 倍',
        '· 不加解释、不加引号、不写旁白',
        '· 直接输出润色后的那一句话',
      ].join('\n');

      const prompt = [
        `角色：${persona || '店长'}`,
        `原文：${skeleton}`,
        '',
        '只输出润色后的一句话。',
      ].join('\n');

      try {
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          system,
          messages: [{
            id: `shop-copy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin:bnn-custom-shop' },
          }],
          maxTokens: 200,
        });
        const text = await collectWithTimeout(stream, timeoutMs);
        if (!text) return null;
        const t = String(text).trim().replace(/^["「『]|["」』]$/g, '').trim();
        return t || null;
      } catch (e) {
        logger?.warn?.(`[shop] LLM 润色失败（用模板原文）：${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
  };
}
