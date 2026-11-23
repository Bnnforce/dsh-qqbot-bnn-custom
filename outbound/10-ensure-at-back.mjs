/**
 * ensure-at-back — 群聊被 @ 后，回复里没写 @ 时自动补上
 *
 * 背景：模型有时会 @ 回发送者，有时不 @；主人要求“被 @ 了就稳定 @ 回去”。
 * 入站 trigger-force-wake 把「最近一次被 @ 的发送者」记到 data/at-sender.json；
 * 这里在出站时按 target(群) + 5 分钟窗口/同一 msgId 匹配，自动在回复开头补 <@senderId>。
 *
 * 2026-10-22 修「@ 重复」：
 *   · 回复里已有任意蓝 @ `<@id>` + 普通 `@昵称` → 保留蓝 @、删掉所有普通 @（@全体成员/@all 除外）；
 *   · 只有普通 `@昵称`（没有蓝 @）→ 不再补蓝 @，避免同一个人被 @ 两遍；
 *   · 一个 @ 都没有 → 才补蓝 @。
 *
 * 只动群聊纯文本回复；不碰主动推送、图片、卡片、已有 @、非首块。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EXT_DATA } from '../lib/pack-paths.mjs';
const STORE = fileURLToPath(new URL('file://' + EXT_DATA + '/at-sender.json'));
const WINDOW_MS = 5 * 60 * 1000;
/** 连续 5 条被动后 QQ 会转主动（target.msgId 消失）；AI 回合内 30 秒内仍可补 @ */
const ACTIVE_FALLBACK_MS = 30 * 1000;

export const name = 'ensure-at-back';

/** 同一回合里已经处理过 @ 的群：后续分段不再重复补 @（避免主人指令转述时每段都 @ 主人） */
const atDoneTurns = new Map();
function rememberAtDone(key) {
  if (!key) return;
  atDoneTurns.set(key, Date.now());
  if (atDoneTurns.size > 200) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, ts] of atDoneTurns) if (ts < cutoff) atDoneTurns.delete(k);
  }
}
export function resetAtBackTurnState() { atDoneTurns.clear(); }

/**
 * 普通 QQ 文本 @昵称：排除邮件 a@b.com、@全体成员、@all。
 * 用它清理“蓝 @ + 普通 @”同一条里重复出现的情况。
 */
const PLAIN_AT_SRC = '(?<![\\w.%+\\-<])@(?!全体成员(?![\u4e00-\u9fa5A-Za-z])|all\\b)[\\w\\u4e00-\\u9fa5-]{1,32}(?![\\w\\u4e00-\\u9fa5-])';
const PLAIN_AT_RE = new RegExp(PLAIN_AT_SRC, 'gu');
const PLAIN_AT_TEST = new RegExp(PLAIN_AT_SRC, 'u');

function stripPlainMentions(text, selfName = '') {
  // 只精确删「@自己的昵称」；@小明2 不算 @小明，@别人的昵称也保留
  let re = PLAIN_AT_RE;
  if (selfName) {
    const esc = String(selfName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?<![\\w.%+\\-<])@${esc}(?![\\w\\u4e00-\\u9fa5-])`, 'gu');
  }
  return String(text ?? '')
    .replace(re, '')
    .replace(/^[ \t]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+(?=\n)/g, '')
    .replace(/[ \t]+$/g, '');
}

/**
 * 归一化：已有蓝 @ 时删掉普通 `@昵称` 重复（不论普通 @ 指向谁）。
 * 如果蓝 @ 不在开头，把它移到最前，保证回复仍然“开头 @ 回对方”。
 * [rf:短号] 永远保持在最前。
 */
export function normalizeAtBack(text, selfId = '', selfName = '') {
  const src = String(text ?? '');
  if (!src) return src;
  if (!/<@[^>]+>/.test(src)) return src;

  // 1) 剥离并保留 [rf:xxx]
  const rfMatch = /^(\s*\[rf:[^\]]+\]\s*)/.exec(src);
  const rf = rfMatch ? rfMatch[1] : '';
  let body = stripPlainMentions(rfMatch ? src.slice(rf.length) : src, selfName);

  // 2) 把第一个蓝 @ 提到最前（已有开头 @ 时不动）
  const blue = /<@[^>]+>/.exec(body);
  // 蓝 @ 是别人时，保留普通 @昵称（可能正是在叫别人），不要误删
  if (blue && selfId && blue[0] !== `<@${selfId}>` && blue[0] !== `<@!${selfId}>`) return src;
  if (blue) {
    const at = blue[0];
    if (!body.trimStart().startsWith(at)) {
      const idx = body.indexOf(at);
      body = `${at} ${body.slice(0, idx)}${body.slice(idx + at.length)}`;
    }
  }
  body = body.replace(/^[ \t]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+(?=\n)/g, '')
    .replace(/[ \t]+$/g, '');
  if (rf && body && !/^\s/.test(body)) return `${rf.trimEnd()} ${body}`;
  return rf + body;
}

/** 创建出站处理器；storePath 可注入，方便单测（默认生产台账） */
export function createOnOutbound(storePath = STORE) {
  return async function onOutbound(ctx, next) {
    try {
      const t = String(ctx?.text ?? '');
      if (!t) return next();
      const kind = String(ctx?.kind ?? '');
      if (kind && kind !== 'text' && kind !== 'markdown') return next();
      if (typeof ctx?.chunkIndex === 'number' && ctx.chunkIndex > 0) return next();

      const scope = String(ctx?.target?.scope ?? '');
      // 出站 target 的真实形状是 {scope,targetId,msgId}；旧文档写的 peerId 实际不存在。
      const peerId = String(ctx?.target?.targetId ?? ctx?.target?.peerId ?? '');
      if (scope !== 'group' || !peerId) return next();

      let store = {};
      try { store = JSON.parse(readFileSync(storePath, 'utf8')) || {}; } catch { return next(); }
      const targetMsg = String(ctx?.target?.msgId ?? '');
      // 优先按当前回复的 msgId 精确找人（多人同时 @ 时不会把 A 的回复补成 B）
      //
      // 🔴 2026-11-06 修（「@ 错人」根因，事故见 trigger-force-wake 里的注释）：
      //   现在 `m:<msgId>` 也会记录**未 @ 的消息**（用于精确识别"在跟谁说话"），
      //   但它带 `notMention: true` 标记 —— **这类记录绝不能用来补 @**。
      //   否则主人单独发「喵喵喵」（没 @），她回复时就会被补 @（@ 谁都错）。
      const exactRec = targetMsg ? store['m:' + targetMsg] : undefined;
      // 「未 @ 消息」的精确命中 → 这条回复本来就不需要 @，直接放行
      if (exactRec && exactRec.notMention === true) return next();

      const rec = exactRec || store[peerId];
      if (!rec || !rec.senderId) return next();

      const sameMsg = Boolean(targetMsg && rec.msgId && targetMsg === rec.msgId);
      const activeFresh = Date.now() - Number(rec.ts ?? 0) < ACTIVE_FALLBACK_MS;
      const turnIdRaw = String(ctx?.turnId ?? '');
      // ⚠️ 2026-11-14 修（真 bug：转主动分支永不生效）：
      //   上游 `transport/outbound.js:722/726` 调 `sendRichOutbound` **只传 11 个实参、没传第 12 参
      //   `extHook`** ⇒ `outbound-buffer.js:55` 走缺省分支，`makeOutboundCtx` 的 `turnId` 恒为 `''`。
      //   所以旧的 `hasTurn = ctx.turnId !== ''` **在正文发送路径上永远是 false** ——
      //   「连续 5 条被动后 QQ 转主动（target.msgId 消失）」这个特例分支从来没进来过，@ 一直漏补。
      //   现在：turnId 有值 ⇒ 肯定是 AI 回合（turnEnd 钩子会传 sessionKey，也走这条）；
      //        没 turnId ⇒ 退一步按「本条没有 msgId + 台账 ts 在 30s 窗口内」判，
      //        定时/日报那种"读了很久以前那次 @"的推送仍然进不来（activeFresh 挡住）。
      const hasTurn = turnIdRaw !== '' || (!targetMsg && activeFresh);
      // 正常：精确回复那条 @ 消息。特例：连续被动后转主动（无 msgId）时，
      // 只有 AI 回合（turnId 或"无 msgId + 30 秒内最近被 @"）+ 30 秒内最近被 @ 才补，定时/日报不会误 @。
      if (!sameMsg) {
        if (!hasTurn || !activeFresh || targetMsg) return next();
      }

      const senderId = String(rec.senderId);
      // turnKey 用于「同一回合只补一次 @」。
      // ⚠️ turnId 为空（上游正文路径的常态，见上面注释）时保持 `''` —— `rememberAtDone('')` 会直接
      //    返回、不记账，于是**每个分段各自补一次 @**。这正是期望行为：每条回复都该 @ 回去，
      //    不能按 peer 窗口去重（那会让 10 分钟内后续回复全都不补 @）。
      const turnKey = turnIdRaw ? `${peerId}|${turnIdRaw}` : '';

      // 纯媒体回复（只有 [MEDIA:...] 或只有图片标记）不补 @；可加 caption，也可直接跳过。
      const mediaOnly = t
        .replace(/\[rf:[^\]]+\]/gi, '')
        .replace(/\[MEDIA:[^\]]+\]/gi, '')
        .replace(/\s+/g, '')
        .trim() === '';
      if (mediaOnly) return next();

      // 连续段/长文本：@ 始终补在最前；即使后面被 QQ 截断，开头 @ 也在截断点前。
      // （不在这里主动截断正文，避免改语义。）

      // 同一回合已经发过带 @ 的分段，后续分段不再自动补 @
      if (turnKey && atDoneTurns.has(turnKey)) return next();

      // ① 已经有任意蓝 @ → 删掉所有普通 @昵称重复（@全体成员/@all 不动），不再补
      if (/<@[^>]+>/.test(t)) {
        rememberAtDone(turnKey);
        const nt = normalizeAtBack(t, senderId, rec.senderName);
        if (nt !== t) { try { ctx.rewrite?.(nt); } catch { /* ignore */ } }
        return next();
      }

      // ② 已经有普通 @昵称（没有蓝 @）→ 不再补蓝 @，避免出现两个 @
      if (PLAIN_AT_TEST.test(t)) { rememberAtDone(turnKey); return next(); }

      // ③ 一个 @ 都没有 → 补蓝 @；引用标记 [rf:xxx] 保持在最前
      const at = `<@${senderId}> `;
      const m = t.match(/^(\[rf:[^\]]+\])\s*/);
      const nextText = m ? `${m[1]} ${at}${t.slice(m[0].length)}` : at + t;
      try { ctx.rewrite?.(nextText); } catch { /* ignore */ }
      rememberAtDone(turnKey);
    } catch { /* ignore */ }
    return next();
  };
}

export default createOnOutbound();
