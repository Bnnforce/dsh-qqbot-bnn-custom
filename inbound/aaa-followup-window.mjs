/**
 * aaa-followup-window — 免 @ 追问窗口（@ 一次，连说几句不用再 @）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 要解决的问题
 *
 *   群里 @ 她一次之后，接下来 2-3 句是连着说的，但每句都得重新 @ ——
 *   很反人类。有了这个窗口，@ 一次就够说完一段对话。
 *
 * ── 怎么实现的（关键，别改错）────────────────────────────────────────────
 *
 *   上游的 @ 门控是 `mentionGate`，它有一个逃生口（实测读源码确认）：
 *
 *     resolveConfig: (ctx) => ctx.state.qqInboundForceWake === true
 *         ? { requireMentionInGroup: false }
 *         : {},
 *
 *   而 `ctx.forceWake()` 在**早挂点（onInbound）**调用时就会置这个 state。
 *   ⇒ 所以本 hook 在窗口内调 `ctx.forceWake()`，这条消息就**不需要 @ 也能唤醒**。
 *
 *   ⚠️ 曾考虑「改写 ctx.platform.mentioned」，但那是个 getter
 *      （`get platform() { return { mentioned: ... } }`），赋值无效。
 *
 * ── 三条安全边界（防"她在群里自说自话"）──────────────────────────────────
 *
 *   ① 按「群 × 用户」隔离 —— A 开的窗口不能被 B 用
 *   ② 轮次上限（默认 2）—— 用完即关，不会无限续期
 *   ③ 时间上限（默认 5 分钟）
 *
 * ── 文件名为什么是 aaa- ──────────────────────────────────────────────────
 *
 *   要早于其他 inbound（尤其早于任何门禁 hook），
 *   保证门控判定时 state 已经置上。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { open, peek, consume, close } from '../lib/pure/followup-window.mjs';
import { addressed } from '../lib/name.mjs';

export const name = 'followup-window';

/** 默认配置（可被 {EXT_DATA}/followup-window.json 覆盖）。 */
const DEFAULTS = {
  enabled: true,
  windowMin: 5,
  maxTurns: 2,
  /** 窗口内她说了"去忙/先这样"这类收尾话 → 主动关窗（避免一直免 @）。 */
  closingHints: ['先去忙', '先这样', '回头聊', '不聊了', '拜拜', '晚安'],
};

function config() {
  // 懒读配置：失败就用默认值，绝不阻塞
  try {
    const raw = globalThis[Symbol.for('qqbot.followup-window.config')];
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function gidOf(ctx) {
  const p = ctx?.peer ?? {};
  return String(p.peerId || p.groupId || ctx?.groupId || '').trim();
}

function uidOf(ctx) {
  const p = ctx?.peer ?? {};
  const m = ctx?.message ?? {};
  return String(
    ctx?.sender?.openid || p.userId || m.senderId || m.senderOpenid || ctx?.senderId || '',
  ).trim();
}

export async function onInbound(ctx, next) {
  try {
    const cfg = config();
    if (cfg.enabled === false) return next();
    if (String(ctx?.scope ?? '') !== 'group') return next();   // 只在群里做

    const gid = gidOf(ctx);
    const uid = uidOf(ctx);
    if (!gid || !uid) return next();

    const text = String(ctx?.text ?? '').trim();
    const called = addressed(ctx);        // 有没有 @ 她 / 叫她名字

    // ① 被叫了 → 开（或续）窗口，然后正常放行
    if (called) {
      open(gid, uid, {
        windowMs: Math.max(1, Number(cfg.windowMin) || 5) * 60 * 1000,
        maxTurns: Math.max(0, Number(cfg.maxTurns) || 0),
      });
      return next();
    }

    // ② 没被叫，但在窗口内 → 免 @ 放行（消耗一轮）
    //
    // ⚠️ 2026-11-24 修（子智能体用例 B1.4 抓到的真 bug）：
    //   本 hook 文件名 aaa- 早于 aab-skip-empty-ping.mjs，
    //   所以「空消息 / 纯 @ 无正文」会**先在这里消耗一轮**，
    //   然后才被空消息门禁拦掉 —— 用户白丢一次机会且没有任何回复。
    //   修法：先判正文是否有实质内容，空的不算数、不消耗轮次。
    const hasContent = (() => {
      const t = String(ctx?.text ?? '')
        .replace(/<@[^>]+>/g, '')
        .replace(/@[^\s]+/g, '')
        .replace(/[★主人\u200b\u200c\u200d\ufeff\s]/gu, '')
        .trim();
      if (t) return true;
      const m = ctx?.message ?? {};
      return Boolean(
        m.image || m.imageUrl || m.file || m.fileUrl || m.voice || m.voiceUrl ||
        m.video || m.videoUrl || (Array.isArray(m.attachments) && m.attachments.length),
      );
    })();
    if (!hasContent) return next();     // 空消息：不消耗轮次，交给后面的门禁处理

    const st = peek(gid, uid);
    if (st.ok) {
      const used = consume(gid, uid);
      if (used) {
        try {
          ctx?.forceWake?.({ reason: 'followup-window' });
        } catch { /* 调用失败就退化成正常流程（会因没 @ 而不唤醒） */ }
        try {
          ctx?.note?.(`免@追问窗口：剩 ${Math.max(0, st.turnsLeft - 1)} 轮`);
        } catch { /* ignore */ }
        return next();
      }
    }

    // ③ 她被叫但说了收尾话 → 关窗（避免窗口一直开着）
    if (cfg.closingHints.some((h) => text && text.includes(h))) {
      close(gid, uid);
    }

    return next();
  } catch {
    // 任何异常都退回正常流程，绝不影响消息处理
    return next();
  }
}

export default { name, onInbound };
