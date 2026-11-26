/**
 * slang-inline — 群内黑话「无感注入」（R4.8）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么是「注入」而不是「工具」：
 *
 * 主人原话：「我需要快速无感的使用方式」。
 *   · 工具方式：模型得先想起来要查 → 不够无感，且要多一轮
 *   · 全量注入：15 条 × 4 群 = 600 token/轮 → 太贵
 *
 * ⇒ 折中：**极简单行常驻注入**
 *   每轮在她的上下文里塞一行（≤60 字 ≈ 20 token）：
 *     【本群黑话】本鲸=自称 ｜ 典=太经典 ｜ 绷不住=笑了
 *   她那一轮直接就能看到，无需任何动作。
 *   完整释义（出处/用法）才走 her_slang 工具按需查。
 *
 * 成本对比：
 *   全量注入 600 token/轮  →  单行 20 token/轮（省 96%）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 纪律：
 *   · **只注入已确认的黑话**（黑话.md），候选.md 绝不进上下文
 *   · 没有黑话本 → 不注入（零成本）
 *   · 任何异常 → 静默跳过，绝不影响消息链路
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PERSONA_ROOT } from '../lib/io/persona-store.mjs';
import { readSlang, renderInline } from '../lib/slang/store.mjs';

export const name = 'slang-inline';

function diag(tag, data) {
  try {
    const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'dsh-anti-ai-persona');
    mkdirSync(dir, { recursive: true });
    appendLogRotating(join(dir, 'slang-inline.log'),
      `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`, 'utf8');
  } catch { /* 日志失败不影响主链路 */ }
}

/** 从 agent 上下文取群 openid。 */
function groupOf(agent) {
  try {
    const peer = agent?.session?.header?.peer || agent?.peer || {};
    const id = String(peer.peerId || peer.groupId || agent?.session?.header?.groupId || '');
    if (peer.scope && peer.scope !== 'group') return '';
    return id;
  } catch { return ''; }
}

export async function run(env) {
  const ctx = env?.ctx;
  if (!ctx?.on) return 'no-ctx';

  const handler = async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;

      const gid = groupOf(payload?.agent);
      if (!gid) return decision;                 // 非群聊 → 不注入

      const list = readSlang(PERSONA_ROOT, gid); // 只读「已确认」
      if (!list.length) return decision;         // 没黑话本 → 零成本

      const inline = renderInline(list);
      if (!inline) return decision;

      // 防重复：同一轮已经注入过就跳过
      const marker = '【本群黑话】';
      for (const m of decision.messages) {
        const c = m?.content;
        const txt = Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('') : String(c || '');
        if (txt.includes(marker)) return decision;
      }

      decision.messages.push({
        role: 'user',
        id: `slang-inline-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        content: [{ type: 'text', text:
          `<system-reminder>\n${marker}（本群自造的词，聊到就用，别解释）\n${inline}\n</system-reminder>` }],
        source: { kind: 'qqbot:slang-inline', form: 'instructions' },
      });
      diag('INJECT', { gid: gid.slice(0, 8), count: list.length, chars: inline.length });
      return decision;
    } catch {
      return decision;    // 失败关闭
    }
  };

  try {
    // ★ 2026-11-26 适配 1.13.26 契约 §8.2：
    //   ctx.on() 返回 disposer，不 dispose 热重载会不断累积（官方明确要求收尾）。
    const off = ctx.on('agent/pre-step', handler, { prepend: true });
    if (typeof off === 'function' && typeof env?.registerDispose === 'function') {
      env.registerDispose(off);
    }
    diag('BOOT', { msg: 'slang-inline 已挂载' });
  } catch (e) {
    diag('BOOT-FAIL', { err: e instanceof Error ? e.message : String(e) });
    return 'no-hook';
  }
  return 'ok';
}

export default { name, run };
