/**
 * outbound/55-sulk-prefix — 小脾气前缀（2026-11-18 R5.1）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个扩展（真实 bug 修复）：
 *
 *   `sulk.ts` 有完整的状态机（冷落 → cold 标记 → 24h 过期 → 到期后第一次回复加「哼」），
 *   但**从没被调用过** —— `decorateOutgoing` 在插件里没有消费方。
 *   实测：`decorateOutgoing` 只被 heartbeat 通道间接用到，普通回复完全不经过。
 *
 *   本扩展用出站链的 `ctx.rewrite()` 把它接活。
 *
 * ── 工作方式 ────────────────────────────────────────────────────────────────
 *   她回复 → 问桥 shouldSulk(群号) → 是 → rewrite('哼。' + 原文) → clearSulk(群号)
 *
 * ── 三条纪律（防 OOC / 防破格式）──────────────────────────────────────────────
 *   ① **只对纯文字生效**（kind 必须是 'text'）：
 *        markdown 加前缀会破坏 `##` 标题；卡片/媒体/转发更不行。
 *   ② **只加一次**：clearSulk 先写盘再返回（插件内部已保证），不会重复加。
 *   ③ **失败关闭**：任何异常直接放行。
 *
 * ── 为什么放在 50 之后 ──────────────────────────────────────────────────────
 *   出站链按**文件名升序**执行：
 *     50-mood-driver  先记录「她原本说了什么」（不含前缀，情绪判定更准）
 *     55-sulk-prefix  再改正文加前缀
 *   顺序反了会导致 mood 把「哼」也算进情绪，判冷。
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const name = 'sulk-prefix';

/** 桥的 Symbol key（与插件 src/index.ts 挂的保持一致） */
const BRIDGE_KEY = 'dsh.anti-ai-persona.mood.v1';

/** 前缀文案（与插件 sulk.ts 的 SULK_PREFIX 同款语义，这里独立一份便于改语气） */
const PREFIX = '哼。';

function getBridge() {
  try {
    return globalThis[Symbol.for(BRIDGE_KEY)] || null;
  } catch {
    return null;
  }
}

export default async function onOutbound(ctx, next) {
  try {
    // ★ 只处理本回合最后一个正文块
    if (ctx?.isLastChunk === false) return next();

    // ★★ 只对纯文字生效 —— markdown/卡片/媒体加前缀会破坏结构
    const kind = String(ctx?.kind || '');
    if (kind !== 'text') return next();

    // ★ 2026-11-20 R5.4 修：真实字段是 target.targetId，不是 peerId！
    //   查 qqbot dist/types.d.ts：ReplyTarget = { scope, targetId, msgId? }
    //   旧代码读 peerId 恒为 undefined ⇒ 整个扩展每轮都从这里退出 ⇒ 功能等于不存在。
    //   （10/20 号扩展早已修过，50/55 漏了 —— 这就是情绪和小脾气从未生效的真根因。）
    const gid = String(ctx?.target?.targetId ?? ctx?.target?.peerId ?? '');
    if (!gid) return next();

    const text = String(ctx?.text || '');
    if (!text.trim()) return next();

    // 已经以「哼」开头 → 不重复加
    if (/^哼/.test(text.trim())) return next();

    const bridge = getBridge();
    if (!bridge || typeof bridge.shouldSulk !== 'function') return next();

    if (bridge.shouldSulk(gid) !== true) return next();

    // ★ 改正文（出站扩展的能力）
    if (typeof ctx.rewrite === 'function') {
      const ok = ctx.rewrite(`${PREFIX}${text}`);
      // 只有真的改成功了才清状态（否则下次还能补上）
      if (ok !== false && typeof bridge.clearSulk === 'function') {
        bridge.clearSulk(gid);
      }
    }
  } catch {
    // 绝不影响出站
  }
  return next();
}
