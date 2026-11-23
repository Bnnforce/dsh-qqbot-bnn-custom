/**
 * botplay/wake-lottery — 唤醒抽奖卡片（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 卡片接口（官方契约）：export default { name, onInit, onClick, onExpire }
 *
 * 这个卡片是 B 模式（邀请群友抽）的落地。
 * 她在"刚睡醒"时发一张卡，群友点「抽一个」按钮抽奖。
 *
 * ⚠️ 三条官方契约铁律（botplay-contract.md）
 *   ① 卡片必须有按钮 —— 没有按钮会直接拒发
 *   ② 按钮权限只能在 onClick 里判 —— 卡片级 perm 做不到按按钮区分
 *   ③ **不要 appendWake** —— 卡片已写明结果，再唤醒会多发一条消息
 *      （全项目三个卡片都因这个问题移除过，见 daily-checkin.mjs:137）
 *
 * ⚠️ 状态按 ctx.cardId 分轮存（ctx.store），否则多张卡会串上一轮的名单。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { EXT_ROOT } from '../lib/pack-paths.mjs';
import { readJsonSafe, writeJsonAtomic } from '../lib/wake-lottery/store.mjs';

export const name = '唤醒抽奖';

/** 懒加载核心。 */
async function core() {
  return import(join(EXT_ROOT, 'lib', 'wake-lottery', 'index.mjs') + '?bp=' + Date.now());
}

/** 卡片按钮（必须有，否则拒发）。 */
const BUTTONS = [
  { id: 'draw', label: '🎁 抽一个', style: 1, botAction: { type: 'reply_text', text: '' } },
  { id: 'atlas', label: '📖 图鉴', style: 0, botAction: { type: 'reply_text', text: '' } },
];

/** 设置卡片正文 + 按钮。 */
function setCard(ctx, text, buttons = BUTTONS) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  c.buttonsPerRow = 2;
  return c;
}

/** 取群号。 */
function gidOf(ctx) {
  return String(
    ctx?.event?.scope === 'group' ? (ctx?.event?.peerId ?? '') : (ctx?.event?.peerId ?? ''),
  ).trim();
}

/** 取点击人 openid。 */
function openidOf(ctx) {
  return String(ctx?.user?.openid ?? '').trim();
}

/** 当前卡片的轮次状态（按 cardId 存，防多卡串台）。 */
function readCardState(ctx) {
  try {
    const store = ctx?.store;
    if (!store || typeof store.load !== 'function') return {};
    const all = store.load() || {};
    const key = String(ctx?.cardId ?? 'default');
    return all[key] && typeof all[key] === 'object' ? all[key] : {};
  } catch {
    return {};
  }
}

/** 写卡片轮次状态。 */
function writeCardState(ctx, patch) {
  try {
    const store = ctx?.store;
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') return false;
    const all = store.load() || {};
    const key = String(ctx?.cardId ?? 'default');
    all[key] = { ...(all[key] || {}), ...patch };
    store.save(all);
    return true;
  } catch {
    return false;
  }
}

export default {
  name,

  /** 卡片首次加载：渲染初始正文 + 按钮。 */
  async onInit(ctx) {
    try {
      const C = await core();
      const cfg = C.loadRuntimeConfig();
      const text = C.buildInviteText({ hhmm: C.hhmmOf(Date.now(), cfg.timezone) }, cfg);
      setCard(ctx, text, BUTTONS);
      // 记录本卡自己的起点时间（供过期判断）
      writeCardState(ctx, { createdAt: Date.now() });
    } catch {
      setCard(ctx, '## 📦 手边有个盒子\n\n点一下按钮，看看里面是什么。', BUTTONS);
    }
  },

  /** 按钮点击。 */
  async onClick(ctx, info) {
    const buttonId = String(info?.buttonId ?? ctx?.buttonId ?? '');
    const gid = gidOf(ctx);
    const openid = openidOf(ctx);

    try {
      const C = await core();
      const cfg = C.loadRuntimeConfig();

      // ── 图鉴按钮 ──
      if (buttonId === 'atlas') {
        if (!gid || !openid) { ctx.emit('拿不到你的身份，看不了图鉴。'); return ''; }
        const a = C.readAtlasFor(gid, openid, cfg);
        ctx.emit(a.text);
        return '';
      }

      // ── 抽奖按钮 ──
      if (!gid || !openid) { ctx.emit('拿不到你的身份，抽不了。'); return ''; }
      if (!cfg.enabled) { ctx.emit('抽奖还没开呢。'); return ''; }

      // ① 校验邀请是否还在（cycleId 过期检查 —— R33）
      const state = C.readState(gid);
      if (!state.pendingInvite) { ctx.emit('盒子已经收了。等她下次醒来吧。'); return ''; }

      // ② 执行抽奖
      const r = await C.executeDraw({
        gid,
        openid,
        name: String(ctx?.user?.name ?? ''),
        cycleId: state.pendingInvite.cycleId,
        cfg,
        consumeInvite: true,
      });

      if (!r.ok) {
        if (r.reason === 'user-daily-cap') {
          ctx.emit(`今天已经抽过 ${cfg.perUserDailyCap} 次了，明天再来。`);
        } else {
          ctx.emit('盒子是空的……下次吧。');
        }
        return '';
      }

      // ③ 富媒体直接发（图片/语音/歌），文本走卡片
      const payload = r.payload || {};
      if (payload.kind === 'image' || payload.kind === 'sticker') {
        try { ctx.image({ localPath: payload.content?.localPath }); } catch { /* ignore */ }
      }

      // ④ 用 ctx.emit 出结果（**不 appendWake** —— 官方契约 + 全项目约定）
      ctx.emit(r.resultText);

      // ⑤ 刷新按钮（本次已抽，禁用重复点）
      try {
        const c = ctx.card();
        c.buttons = BUTTONS.filter((b) => b.id !== 'draw');
        c.dirty = true;
      } catch { /* ignore */ }

      return '';
    } catch (e) {
      try { ctx.emit('抽的时候出了点问题，下次吧。'); } catch { /* ignore */ }
      return '';
    }
  },

  /** 卡片过期：清理本轮的邀请。 */
  async onExpire(ctx) {
    try {
      const C = await core();
      const gid = gidOf(ctx);
      if (!gid) return;
      const state = C.readState(gid);
      if (state.pendingInvite) {
        state.pendingInvite = null;
        C.writeState(gid, state);
      }
    } catch { /* ignore */ }
  },

  onDispose() {
    // 无需要清理的资源
  },
};
