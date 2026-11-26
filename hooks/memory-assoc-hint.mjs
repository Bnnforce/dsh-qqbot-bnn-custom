/**
 * memory-assoc-hint — 发散联想注入（R8，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人原话：
 *   「各个记忆模块和相关的功能模块能互相联动，人格和模型也能自动去寻找，
 *     让它自己去像更像一个人一样，发散的思维去寻找信息」
 *
 * ── 这个 hook 做两件事 ────────────────────────────────────────────────────
 *
 *   ① **自动联想**：当前这句话里如果提到了记忆里的东西，
 *      把相关的（人/事/梗/关系）主动带进上下文 —— 她不用去查就"想起来了"
 *
 *   ② **告诉它还能查什么**：附带一句「你还能查 N 个黑话、M 段群史…」，
 *      引导模型**自己决定**要不要深入查
 *
 * ── 纪律（防打扰）──────────────────────────────────────────────────────
 *
 *   · 联想为空 → 什么都不注入（零成本）
 *   · 同一群 10 分钟内最多注入一次（防止连续几轮都塞）
 *   · 输出严格限量（≤8 条，防 token 爆炸）
 *   · 失败关闭，绝不影响主链路
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXT_DATA } from '../lib/pack-paths.mjs';
import { associate, hintFor, renderAssoc } from '../lib/memory/associate.mjs';

export const name = 'memory-assoc-hint';

/** 同一群两次注入的最小间隔。 */
const MIN_GAP_MS = 10 * 60_000;

/** 每群上次注入时间。 */
const lastAt = new Map();

function diag(tag, data) {
  try {
    const dir = join(EXT_DATA, 'memory');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'assoc.log'),
      JSON.stringify({ at: new Date().toISOString(), tag, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响主链路 */ }
}

/** 从 agent 取群 id。 */
function groupOf(agent) {
  try {
    const key = String(agent?.session?.id ?? agent?.options?.sessionId ?? '');
    const m = key.match(/group[:/]?([0-9A-Fa-f]{32})/);
    if (m) return m[1];
    const g = String(agent?.session?.header?.peerId ?? agent?.options?.peerId ?? '');
    if (/^[0-9A-Fa-f]{32}$/.test(g)) return g;
    return '';
  } catch { return ''; }
}

/** 取本轮用户文本。 */
function userTextOf(decision) {
  try {
    const msgs = Array.isArray(decision?.messages) ? decision.messages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (!m || m.role !== 'user') continue;
      const c = m.content;
      const txt = Array.isArray(c)
        ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
        : String(c || '');
      if (txt.trim()) return txt;
    }
    return '';
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
      if (!gid) return decision;

      // 频率限制
      const now = Date.now();
      if (now - (Number(lastAt.get(gid)) || 0) < MIN_GAP_MS) return decision;

      const text = userTextOf(decision);
      if (!text) return decision;

      // 发散联想
      const r = associate(gid, text);
      if (!r.hits.length) return decision;      // 无联想 → 零成本

      const body = renderAssoc(r.hits);
      if (!body) return decision;

      const hint = hintFor(gid);
      const text2 = [
        '<system-reminder>',
        '（你想起了一些相关的事，可以自然地用上：）',
        body,
        hint ? hint : '',
        '</system-reminder>',
      ].filter(Boolean).join('\n');

      // 防重复
      const marker = '你想起了一些相关的事';
      for (const m of decision.messages) {
        const c = m?.content;
        const t = Array.isArray(c)
          ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
          : String(c || '');
        if (t.includes(marker)) return decision;
      }

      decision.messages.push({
        role: 'user',
        id: `mem-assoc-${now}-${Math.random().toString(36).slice(2, 6)}`,
        content: [{ type: 'text', text: text2 }],
        source: { kind: 'qqbot:memory-assoc', form: 'instructions' },
      });

      lastAt.set(gid, now);
      diag('INJECT', { gid: gid.slice(0, 8), hits: r.hits.length, hops: [...new Set(r.hits.map((h) => h.hop))] });
      return decision;
    } catch {
      return decision;
    }
  };

  try {
    const off = ctx.on('agent/pre-step', handler, { prepend: true });
    if (typeof off === 'function' && typeof env?.registerDispose === 'function') {
      env.registerDispose(off);
    }
    diag('BOOT', { msg: 'memory-assoc-hint 已挂载' });
  } catch (e) {
    diag('BOOT-FAIL', { err: e instanceof Error ? e.message : String(e) });
    return 'no-hook';
  }
  return 'ok';
}

export default { name, run };
