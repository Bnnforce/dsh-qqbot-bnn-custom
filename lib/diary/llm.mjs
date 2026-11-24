/**
 * diary/llm — 调宿主 LLM 生成一篇日记（R6.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么不复用 shop/adapters/llm-host.mjs 的 createHostLlm().polish()
 *
 *   那个是「润色一句话」，prompt 是"只润色不新增"。日记是「生成一篇」，
 *   完全不同的任务。但它的**底层收流逻辑**（llm.stream + collectStreamText +
 *   超时）是通用的，这里照抄同一套，避免重复踩坑。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 关键约束（照抄 llm-host 头部注释的教训）：
 *
 *   · `kernel.get('llm')` 在 **handler / 定时任务**里能拿到，在**按钮回调**里拿不到。
 *     日记只在定时任务（diary-task hook）里调，所以安全。
 *   · `llm.stream({provider, model, system, messages, maxTokens})` 是唯一正确入口。
 *   · 失败必须静默降级（返回 null），绝不抛、绝不影响主链。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { svcOf, resolveDefaultRoute } from '../shop/adapters/llm-host.mjs';

/** 收流（同 llm-host.collectStreamText）。 */
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

/** 带超时收集。超时返回 null。 */
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

/** 拼接日记生成 prompt。 */
function buildPrompt(persona, events, meta) {
  const lines = [];
  lines.push(`你是在给「${persona}」写今天（${meta.date}）的日记。`);
  lines.push('');
  lines.push('今天这个群里发生了这些事（按时间顺序）：');
  if (!events || !events.length) {
    lines.push('（今天群里很安静，没什么人说话）');
  } else {
    for (const e of events) lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push('用「' + persona + '」的口吻，写一篇 150-250 字的日记。');
  lines.push('');
  lines.push('铁律：');
  lines.push('· 第一人称（"我"），像她自己晚上睡前写的');
  lines.push('· 只写这个群里真实发生的事，不编造、不脑补');
  lines.push('· 不出现群友的真实昵称或编号，用"有人""大家""他/她"代指');
  lines.push('· 不写敏感内容、不写隐私、不写具体争吵细节');
  lines.push('· 结尾可以有一句她自己的小情绪或小想法');
  lines.push('· 直接输出日记正文，不加"今天的日记："这类标题，不加引号，不加旁白');
  return lines.join('\n');
}

/**
 * 调 LLM 生成一篇日记。
 *
 * @param {object} p
 * @param {any} p.ctx         定时任务的 ctx（能拿到 llm 服务）
 * @param {string} p.persona   人格名（爱莉希雅）
 * @param {string[]} p.events  脱敏后的群聊事件列表
 * @param {{date:string, timeoutMs?:number}} p.meta
 * @returns {Promise<string|null>} 日记正文；失败/超时/无模型 → null
 */
export async function generateDiary(p) {
  try {
    const llm = svcOf(p.ctx, 'llm');
    if (!llm || typeof llm.stream !== 'function') return null;

    const route = await resolveDefaultRoute(llm);
    if (!route) return null;

    const timeoutMs = Number(p.meta?.timeoutMs) > 0 ? Number(p.meta.timeoutMs) : 15_000;

    const system = [
      '你是一个温柔、细腻、会写日记的角色。',
      '你的日记自然、不煽情、不刻意，像真实的人睡前随手写的。',
    ].join('\n');

    const prompt = buildPrompt(p.persona, p.events, p.meta);

    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{
        id: `diary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:bnn-custom-diary' },
      }],
      maxTokens: 400,
    });

    const text = await collectWithTimeout(stream, timeoutMs);
    if (!text || !text.trim()) return null;

    // 清理：去掉可能残留的标题/引号/首尾空白
    const clean = text
      .replace(/^#+\s*/g, '')
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .trim();
    return clean || null;
  } catch {
    return null;
  }
}

export default { generateDiary };
