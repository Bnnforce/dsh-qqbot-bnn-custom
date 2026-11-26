/**
 * life-stream-hint — 生活流素材注入（R7 Stage 2 收尾，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件（方案里最强调的一点）：
 *
 *   R7 方案原文：「真正的难点不是生成，是**让她自然地说起**。
 *   验收标准不是『生成了多少条』，而是『她说话时有没有真的用过』。」
 *
 *   生活流每小时落一条日志，但如果没有任何代码去读它，
 *   那这些数据就是死的 —— 这个功能等于没做。
 *
 * ── 设计原则（防止「没话找话」）──────────────────────────────────────────
 *
 *   ❌ 不做：每轮都硬塞「你今天做了什么」→ 会变成祥林嫂
 *   ✅ 要做：**只在话题相关时**才给素材，让她"想起来"
 *
 *   判断依据（全部可观测，不靠猜）：
 *     ① 当前消息提到「今天 / 刚才 / 最近 / 在干嘛」等时间词
 *     ② 或者当前消息里有情绪/状态词（累、开心、无聊）
 *
 *   都不满足 → **不注入**（零 token 成本）
 *
 * ── 成本 ────────────────────────────────────────────────────────────────
 *   命中时注入 1 行（≤50 字 ≈ 18 token）
 *   未命中 0 成本
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { join } from 'node:path';

import { EXT_DATA } from '../lib/pack-paths.mjs';
import { readTodayLog } from '../lib/life-stream/store.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';

export const name = 'life-stream-hint';

/**
 * 触发注入的「询问她在做什么」短语。
 *
 * ★ 2026-11-26 收窄（避免打扰）：
 *   第一版用了「今天 / 最近 / 刚才」这类**宽泛时间词**，
 *   结果「今天天气不错」也会触发注入 —— 那是陈述，不是在问她，
 *   硬塞「你今天…」会显得没话找话。
 *
 *   现在只保留**明确在问她状态**的短语。
 *   宁可少注入，也不要变成祥林嫂。
 */
const ASK_WORDS = [
  '在干嘛', '干嘛呢', '在做什么', '做什么呢', '忙什么', '忙什么呢',
  '干什么呢', '有事吗', '在吗在吗',
];

/** 触发注入的状态词（对方在说自己累/开心等，她可以呼应自己的状态）。 */
const MOOD_WORDS = [
  '累', '困', '疲惫', '没精神', '睡不着', '无聊', '好烦',
  '开心', '高兴', '难过', '心情', 'emo',
];

/** 同一群两次注入的最小间隔（防止连续几轮都塞）。 */
const MIN_INJECT_GAP_MS = 30 * 60_000;

/** 每群上次注入时间（内存即可，重启清零无所谓）。 */
const lastInject = new Map();

function diag(tag, data) {
  try {
    const dir = join(EXT_DATA, 'life-stream');
    mkdirSync(dir, { recursive: true });
    appendLogRotating(join(dir, 'inject.log'),
      JSON.stringify({ at: new Date().toISOString(), tag, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响主链路 */ }
}

/** 取当前 agent 的群 id（与 slang-inline 同一套判定）。 */
function groupOf(agent) {
  try {
    const cwd = String(agent?.session?.header?.cwd ?? '');
    // QQ 群会话的 cwd 在 Bot 工作区；gid 从 session key 或 header 拿
    const key = String(agent?.session?.id ?? agent?.options?.sessionId ?? '');
    const m = key.match(/group[:/]?([0-9A-Fa-f]{32})/);
    if (m) return m[1];
    const g = String(agent?.session?.header?.peerId ?? agent?.options?.peerId ?? '');
    if (/^[0-9A-Fa-f]{32}$/.test(g)) return g;
    return cwd ? '' : '';
  } catch { return ''; }
}

/**
 * 从消息正文判断是否该注入（纯函数，可测）。
 *
 * 两个触发条件（任一满足即可）：
 *   ① 明确在问她「在做什么」→ 她可以带一句自己的状态
 *   ② 对方在说自己累/开心等状态 → 她可以呼应「我今天也…」
 *
 * 不满足则**不注入**（零成本，零打扰）。
 */
export function shouldInject(text) {
  const t = String(text ?? '');
  if (!t) return { hit: false, reason: 'empty' };

  // ① 在问她做什么
  for (const w of ASK_WORDS) {
    if (t.includes(w)) return { hit: true, reason: 'ask:' + w };
  }
  // ② 对方在说自己的状态
  for (const w of MOOD_WORDS) {
    if (t.includes(w)) return { hit: true, reason: 'mood:' + w };
  }
  return { hit: false, reason: 'no-trigger' };
}

/** 把日志渲染成一行（纯函数，可测）。 */
export function renderHint(logs, now = Date.now()) {
  const list = Array.isArray(logs) ? logs : [];
  if (!list.length) return '';

  // 取最近一条（最新的才是"此刻")
  const last = list[list.length - 1];
  const detail = String(last?.detail ?? '').trim();
  if (!detail) return '';

  // 太旧的不用（超过 3 小时就不是"现在"了）
  const at = Number(last?.at) || 0;
  if (at > 0 && now - at > 3 * 3600_000) return '';

  return `（你今天${clamp(detail, 44)}）`;
}

function clamp(s, n) {
  const t = String(s ?? '').replace(/\s+/g, '').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

/** 从 decision.messages 里提取本轮用户文本（用于判断话题）。 */
function userTextOf(decision) {
  try {
    const msgs = Array.isArray(decision?.messages) ? decision.messages : [];
    // 从后往前找 user 消息
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
      if (!gid) return decision;                        // 非群聊 → 不注入

      // ① 话题判断：不相关就不注入（关键：防祥林嫂）
      const userText = userTextOf(decision);
      const judge = shouldInject(userText);
      if (!judge.hit) return decision;

      // ② 频率限制：同一群 30 分钟内只注入一次
      const now = Date.now();
      const lastAt = Number(lastInject.get(gid)) || 0;
      if (now - lastAt < MIN_INJECT_GAP_MS) return decision;

      // ③ 取今天的日志
      const logs = readTodayLog(gid);
      const hint = renderHint(logs, now);
      if (!hint) return decision;

      // ④ 防重复：本轮已有同类注入就跳过
      const marker = '（你今天';
      for (const m of decision.messages) {
        const c = m?.content;
        const txt = Array.isArray(c)
          ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
          : String(c || '');
        if (txt.includes(marker)) return decision;
      }

      decision.messages.push({
        role: 'user',
        id: `life-hint-${now}-${Math.random().toString(36).slice(2, 6)}`,
        content: [{ type: 'text', text: `<system-reminder>\n${hint}\n聊到相关话题自然带一句就行，别生硬复述。\n</system-reminder>` }],
        source: { kind: 'qqbot:life-stream-hint', form: 'instructions' },
      });

      lastInject.set(gid, now);
      diag('INJECT', { gid: gid.slice(0, 8), reason: judge.reason, chars: hint.length });
      return decision;
    } catch {
      return decision;      // 失败关闭，绝不影响主链路
    }
  };

  try {
    const off = ctx.on('agent/pre-step', handler, { prepend: true });
    if (typeof off === 'function' && typeof env?.registerDispose === 'function') {
      env.registerDispose(off);
    }
    diag('BOOT', { msg: 'life-stream-hint 已挂载' });
  } catch (e) {
    diag('BOOT-FAIL', { err: e instanceof Error ? e.message : String(e) });
    return 'no-hook';
  }
  return 'ok';
}

export default { name, run };
