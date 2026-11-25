/**
 * pair-relation-track — 入站解析 @ 提及，累计群内「人与人」互动（R6.7 · 缺口 3）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要
 *
 *   现有关系数据（插件 relationship.js）是「她 → 群友」的单向好感度。
 *   它不知道「A 和 B 熟不熟」。后果：A 和 B 刚吵完架，她可能同时夸两边。
 *
 *   本 hook 在入站时解析「谁 @ 了谁」和「谁紧接着谁说话」，累计成
 *   「A ↔ B」的成对互动次数，落到 pair-relations 文件。累计到阈值
 *   （默认 10 次）就标记为 close（熟）。
 *
 * ── 铁律：只从互动，不从情绪 ───────────────────────────────────────────────
 *
 *   只认「@ 提及」「相邻发言」这类可观察行为，绝不判断「这两条消息是吵架
 *   还是亲热」。判情绪会误判冲突（friction），代价大，路线明确不做 friction。
 *
 * ── 为什么用入站实时解析，而不是定时扫文件 ─────────────────────────────────
 *
 *   入站时就能拿到 senderId、群号、正文里的 <@openid>，实时累计最省事，
 *   也不用去扫 msg-history（那是 diary/回忆录的路子，重）。
 *
 * ── 数据落点（与现有单向关系分开）─────────────────────────────────────────
 *
 *   {EXT_DATA}/pair-relations/<gid>.json  ← 新目录，运行时数据，不入 git
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { applyInteractions } from '../lib/pair-relation/store.mjs';
import { inferInteractions } from '../lib/pair-relation/infer.mjs';

export const name = 'pair-relation-track';

/** 群号（只认群聊）。 */
function gidOf(ctx) {
  const p = ctx?.peer ?? {};
  const m = ctx?.message ?? {};
  return String(p.peerId || p.groupId || m.groupOpenid || m.groupId || ctx?.groupId || '').trim();
}

/** 发送者 openid。 */
function uidOf(ctx) {
  const p = ctx?.peer ?? {};
  const m = ctx?.message ?? {};
  return String(
    ctx?.sender?.openid ?? p.userId ?? m.senderId ?? m.senderOpenid ?? ctx?.senderId ?? ctx?.sender ?? '',
  ).trim();
}

/** 正文。 */
function textOf(ctx) {
  const m = ctx?.message ?? {};
  return String(ctx?.text ?? m.content ?? m.text ?? ctx?.content ?? '').trim();
}

export async function onInbound(ctx, next) {
  try {
    if (String(ctx?.scope ?? ctx?.message?.kind ?? '') !== 'group') return next();

    const gid = gidOf(ctx);
    const uid = uidOf(ctx);
    const text = textOf(ctx);
    if (!gid || !uid || !text) return next();

    // 机器人自己不算；必须真 @ 了某个群友才值得累计
    if (uid === 'self' || uid === 'robot' || uid === 'bot') return next();
    if (!/<@[0-9A-Fa-f]{32}>/.test(text)) return next();

    // 构造单条消息，交给 inferInteractions（它只从 @ 互动推断）
    const messages = [{ s: uid, x: text, t: Date.now() }];
    const interactions = inferInteractions(messages);

    if (interactions && interactions.size) {
      // 不传 dataRoot，让 store 用 pack-paths.mjs 的 EXT_DATA（{EXT_DATA}/pair-relations/<gid>.json）
      applyInteractions(null, gid, interactions, Date.now());
    }
  } catch { /* 累计失败绝不影响消息处理 */ }
  return next();
}

export default { name, onInbound };
