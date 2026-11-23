/**
 * wake_lottery_card — 唤醒抽奖卡片工具（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 为什么必须有这个工具（2026-11-22 真机踩坑记录）
 *
 * 需求：她"刚睡醒"时**主动**在群里发一张带按钮的抽奖卡片。
 *
 * 试过三条路，前两条都是死的：
 *
 *   ① `caps.wakeTo(gid, prompt)` —— 让 AI "发一张卡片"
 *      → 完全错误：wakeTo 只会让 AI **说一句话**，没有任何发卡能力
 *      → 真机：群里两行纯文本「手边有个盒子 / 点一下按钮」，**没按钮**（主人截图反馈）
 *
 *   ② hook 里直接 `caps.markdownCard(text, keyboard)`
 *      → 卡片能发出去，但**点了没反应**
 *      → 根因：官方点击派发链只认 `tools` 和 `commands` 的 `onInteraction`
 *        （见 dist/features/ext-tool-interaction.js:88,93），**hooks 不在链里**
 *
 *   ③ ✅ 本工具：`tools/` 支持 `onInteraction`，能被点击派发认领
 *      → hook 通过 `wakeTo` 让 AI 调本工具 → 工具发卡并登记 → 点击回到 onInteraction
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 官方契约要点（docs/extension-contract.md）
 *   · 发回调按钮卡必须先 `env.registerInteractionCard({cardId, buttonIds, expireAt})`
 *     否则点了没人认（落回原兜底只 ack）
 *   · 按钮 data 格式：`ext:<工具名>:<卡片id>:<按钮id>`
 *   · 派生上下文：`ctx?.caps ?? ctx`（命令/tool 侧有 caps，回调侧平铺）
 */
import { join } from 'node:path';
import { EXT_ROOT } from '../lib/pack-paths.mjs';

/** 本工具名（按钮 data 里要用，必须与 name 一致）。 */
export const TOOL = 'wake_lottery_card';

/** 卡片有效期（与唤醒抽奖的 inviteExpireMs 对齐：2 小时）。 */
const EXPIRE_SEC = 7200;

/** 懒加载核心。 */
async function core() {
  return import(join(EXT_ROOT, 'lib', 'wake-lottery', 'index.mjs') + '?tl=' + Date.now());
}

/**
 * 取第一个**非空**字符串。
 *
 * ⚠️ 为什么不能直接用 `??` 串联：`??` 只跳过 null/undefined，
 *    遇到 `''` 会立刻返回空串 → 整条兜底链断死。
 *    （R-05 实测：`makeExtCaps()` 造的卡片里不少字段是空串，必须跳过。）
 */
function firstStr(...vals) {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

/**
 * 从 ctx 取群号。
 *
 * ═══ 2026-11-22 真机修复 ═══
 * 官方回调的 ctx **就是 caps 平铺**（bootstrap.js:1088 makeCtx 返回 caps 本身），
 * 没有 `ctx.caps`、没有 `ctx.message`。真实字段：
 *
 *   ctx.peer         { scope:'group'|'c2c', peerId }  ← ★ 群号在这里（peer.peerId）
 *   ctx.scope        'group' | 'c2c'
 *   ctx.performer    { openid, name, isOwner }  ← 点击者身份
 *   ctx.replyTarget  回复目标
 *
 * ═══ 2026-11-23 R-05 修复（「拿不到你的身份，抽不了」的真根因）═══
 * 上一版以为群号在顶层 `ctx.peerId` —— **回调侧根本没有这个字段**
 * （实测 makeExtCaps 顶层 keys 里没有 peerId，也没有 caps 自引用），
 * 于是 gidOf() 恒返回 ''，onInteraction 每次都撞进 `if (!gid || !openid)`。
 * 群号的真身在 `ctx.peer.peerId`（实测 ctx.peer = {scope:'group', peerId:'GID…'}）。
 *
 * tool 的 run() 侧才可能有 ctx.caps / ctx.message。
 * 所以取值顺序：peer.peerId → caps.peer.peerId → 顶层 peerId（兼容）
 *              → caps.peerId → message.groupOpenid → groupOpenid
 *
 * ⚠️ c2c（单聊）时必须返回 ''：单聊下 `peer.peerId` 装的是**对方 openid**，
 *    不是群号。若原样返回，run() 会拿 openid 去拼 `/v2/groups/<openid>/messages`
 *    （反而比改动前更糟：改动前恒 '' ，至少会被 `if (!gid)` 拦住）。
 *    所以下面先看 scope，明确不是 group 就直接空串。
 */
function gidOf(ctx) {
  const c = ctx?.caps ?? ctx ?? {};
  const m = ctx?.message ?? {};
  const peer = ctx?.peer ?? c?.peer ?? null;
  const scope = String(peer?.scope ?? ctx?.scope ?? c?.scope ?? '').trim();
  if (scope === 'c2c') return '';   // 单聊：没有群号，别把 openid 当群号
  return firstStr(
    peer?.peerId,          // ★ 真实回调侧：群号在这里（实测 ctx.peer = {scope:'group', peerId:'GID…'}）
    ctx?.peerId,           // 兼容：某些路径可能真的塞了顶层 peerId
    c?.peerId,
    m?.groupOpenid,
    ctx?.groupOpenid,
  );
}

/**
 * 从 ctx 取点击者 openid。
 *
 * ═══ 2026-11-22 真机修复（就是「拿不到你的身份，抽不了」的根因）═══
 * 原来读 `ctx.user.openid` —— **回调侧根本没有 ctx.user**。
 * 官方把点击者放在 `ctx.performer = { openid, name, isOwner }`（bootstrap.js:1118）。
 *
 * 取值顺序：
 *   ctx.performer.openid    ← 回调侧（按钮点击）
 *   ctx.actorOpenid         ← caps 里的同义字段
 *   ctx.caps.performer.openid / ctx.caps.actorOpenid
 *   ctx.user.openid         ← tool run 侧
 */
function openidOf(ctx) {
  const c = ctx?.caps ?? ctx ?? {};
  // R-05 顺手加固：原来用 `??` 串联，`ctx.performer.openid === ''` 时链会断死；
  // 换成 firstStr 只是"跳过空串继续往下找"，**取值顺序一字未改**
  // （performer.openid 仍是第一顺位，已真机验证这条是对的）。
  return firstStr(
    ctx?.performer?.openid,     // ★ 回调侧真实字段
    ctx?.actorOpenid,
    c?.performer?.openid,
    c?.actorOpenid,
    ctx?.user?.openid,
  );
}

/** 拼一个按钮（data 由外层填）。 */
function btn(id, label, style = 1) {
  return {
    id,
    render_data: { label, visited_label: label, style },
    action: {
      type: 1,
      permission: { type: 2 },
      data: '',
      unsupport_tips: '请升级QQ客户端后重试',
    },
  };
}

/**
 * 拼内联键盘。data 必须恰好 `ext:<TOOL>:<cardId>:<buttonId>` 四段。
 *
 * ⚠️ 会话列表命令的注释里写着：**按钮 id 绝不能带冒号**
 *    （插件按冒号 split，多一段会被静默丢弃 → 点了只弹"操作成功"）。
 */
function keyboardOf(cardId) {
  const rows = [[
    { ...btn('draw', '🎁 抽一个', 1), action: { ...btn('draw', '🎁 抽一个', 1).action, data: `ext:${TOOL}:${cardId}:draw` } },
    { ...btn('atlas', '📖 图鉴', 0), action: { ...btn('atlas', '📖 图鉴', 0).action, data: `ext:${TOOL}:${cardId}:atlas` } },
  ]];
  return { content: { rows: rows.map((r) => ({ buttons: r })) } };
}

export default {
  name: TOOL,
  expose: 'qq',

  description:
    '发一张「唤醒抽奖」卡片到当前群，群友可点按钮抽奖。'
    + '用于她"刚睡醒"时主动发起互动。卡片 2 小时内有效，每人每天限次。'
    + '不需要参数；同一群短时间内不要重复发。',

  inputSchema: {
    // 无必填参数（卡片的正文与按钮由工具自己生成）
    note: { type: 'string', description: '可选：内部备注，不展示给群友' },
  },

  /**
   * 发卡。
   *
   * @param {{note?:string}} args
   * @param {object} env tool 侧能力包
   */
  async run(args = {}, env = {}) {
    const ctx = env?.caps ? env : { caps: env };
    const gid = gidOf(ctx);
    if (!gid) return { ok: false, msg: '只能在群里发抽奖卡片。' };

    try {
      const C = await core();
      const cfg = C.loadRuntimeConfig();

      // 正文
      const text = C.buildInviteText({ hhmm: C.hhmmOf(Date.now(), cfg.timezone) }, cfg);

      // 卡片 id（短、唯一）
      const cardId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const kb = keyboardOf(cardId);

      // 必须注册，否则点击没人认领
      try {
        const c = ctx?.caps ?? ctx ?? {};
        if (typeof c.registerInteractionCard === 'function') {
          c.registerInteractionCard({
            cardId,
            buttonIds: ['draw', 'atlas'],
            expireAt: Date.now() + EXPIRE_SEC * 1000,
          });
        }
      } catch { /* 登记失败不影响发卡 */ }

      // 发卡（tier① api 直发 → tier② markdownCard）
      const c = ctx?.caps ?? ctx ?? {};
      let sent = false;

      try {
        if (typeof c.api === 'function') {
          const body = { msg_type: 2, markdown: { content: text }, keyboard: kb };
          const r = await c.api(`/v2/groups/${gid}/messages`, { method: 'POST', body });
          sent = !!(r && r.ok !== false);
        }
      } catch { /* 落下一级 */ }

      if (!sent) {
        try {
          if (typeof c.markdownCard === 'function') sent = !!(await c.markdownCard(text, kb));
        } catch { /* ignore */ }
      }

      if (!sent) return { ok: false, msg: '卡片没发出去（可能没开通卡片权限）。' };

      return { ok: true, msg: '抽奖卡片已发出。', data: { cardId } };
    } catch (e) {
      return { ok: false, msg: `发卡失败：${e instanceof Error ? e.message : String(e)}` };
    }
  },

  /**
   * 按钮点击回调。
   *
   * ⚠️ 官方契约：返回非空字符串 = 回给点击者一句话；返回空串 = 不额外发消息。
   *    本卡片的结果由自己 `ctx.emit` 发，所以返回 ''。
   *
   * @param {object} ctx 回调侧上下文（能力**平铺在 ctx 自身**，没有 caps 键）
   * @param {{buttonId:string, buttonLabel?:string, clickedBefore?:number}} info
   */
  async onInteraction(ctx, info) {
    const buttonId = String(info?.buttonId ?? ctx?.buttonId ?? '');
    const c = ctx?.caps ?? ctx ?? {};
    const gid = gidOf(ctx);
    const openid = openidOf(ctx);

    // ⚠️ 2026-11-22 修：原来同时调 markdown 和 text → 每条回执发两遍（实测）。
    //   只走 markdown（支持富文本，且纯文本会自动降级）。
    const reply = (t) => {
      try {
        if (typeof c.markdown === 'function') { void c.markdown(t); return; }
        if (typeof c.text === 'function') { void c.text(t); return; }
      } catch { /* ignore */ }
    };

    try {
      const C = await core();
      const cfg = C.loadRuntimeConfig();

      // 图鉴
      if (buttonId === 'atlas') {
        if (!gid || !openid) { reply('拿不到你的身份，看不了图鉴。'); return ''; }
        const a = C.readAtlasFor(gid, openid, cfg);
        reply(a.text);
        return '';
      }

      // 抽奖
      if (!gid || !openid) { reply('拿不到你的身份，抽不了。'); return ''; }
      if (!cfg.enabled) { reply('抽奖还没开呢。'); return ''; }

      const state = C.readState(gid);
      const r = await C.executeDraw({
        gid,
        openid,
        name: String(ctx?.performer?.name || ctx?.user?.name || ''),
        cycleId: state?.pendingInvite?.cycleId || state?.lastCycleId || '',
        cfg,
        consumeInvite: true,
      });

      if (!r.ok) {
        if (r.reason === 'user-daily-cap') reply(`今天已经抽过 ${cfg.perUserDailyCap} 次了，明天再来。`);
        else reply('盒子是空的……下次吧。');
        return '';
      }

      // 富媒体
      const payload = r.payload || {};
      if (payload.kind === 'image' || payload.kind === 'sticker') {
        try { if (typeof c.image === 'function') void c.image({ localPath: payload.content?.localPath }); } catch { /* ignore */ }
      }

      reply(r.resultText);
      return '';
    } catch (e) {
      reply('抽的时候出了点问题，下次吧。');
      return '';
    }
  },
};
