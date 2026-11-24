/**
 * botplay/shop — 小店卡片（2026-11-17 重写版）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 本次重写的原因（2026-11-17 复盘）：
 *   第一版没看官方文档 `docs/botplay-contract.md` 就动手，犯了三个错：
 *     ① 用 default.run 而不是 onInit/onClick  → 报「模块没有导出任何钩子」
 *     ② 自己用 event.senderId 取用户           → 官方给 ctx.user
 *     ③ 自己造文件存储 + 重启生效              → 官方给 ctx.store + 热重载
 *   本版严格按契约写，与 checkin-stats.mjs 同一套写法。
 *
 * ── 遵循的官方契约（docs/botplay-contract.md）────────────────────────────
 *   · 导出 default { name, onInit(ctx), onClick(ctx, info) }
 *   · 用户信息走 ctx.user { openid, name, pureName, isOwner }
 *   · 群 id 走 ctx.event.peerId
 *   · 状态走 ctx.store.load() / save()（落 data/<文件名>.json）
 *   · 只有真要刷新按钮状态才 card().dirty = true（别乱置，会刷屏 + 撞限频）
 *   · 状态按 ctx.cardId 分轮存（多张卡片不串）
 *   · ctx.appendWake(text) 让 AI 本体知道发生了什么
 *
 * ── 设计决定（主人 2026-11-17 定）────────────────────────────────────────
 *   **不加 card-nav 的通用导航按钮**（日历/骰子/抽签）。
 *   小店是沉浸式场景，底部摆日历骰子会出戏。这是与 dice/calendar 有意不同。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { withClickerMention } from '../lib/pure/card-format.mjs';
// ★ 2026-11-20 路径规范（开源上架）：全部从 pack-paths 推导，禁止硬编码绝对路径
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { SHOP_ROOT, PERSONA_ROOT, POINTS_ROOT } from '../lib/dirs.mjs';

const SHOP_LIB = `${EXT_ROOT}/lib/shop/index.mjs`;
const SWITCH_LIB = `${EXT_ROOT}/lib/io/persona-switch.mjs`;
const PERSONA_LIB = `${EXT_ROOT}/lib/io/persona-store.mjs`;
// 测试隔离：允许环境变量覆盖（自动化测试用临时目录）
const SHOP_DATA = SHOP_ROOT;


const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// ★ 测试隔离（2026-11-17）：允许用环境变量覆盖数据目录，
//   否则自动化测试会往生产目录写测试用户（已发生过一次污染）。
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）

// ★ 统一积分排版（单一真源在 pack 的 lib/points/format.mjs）
const FORMAT_LIB = `${EXT_ROOT}/lib/points/format.mjs`;
async function formatMod() { return import(FORMAT_LIB + '?f=' + Date.now()); }

async function pointsMod() { return import(POINTS_LIB + '?b=' + Date.now()); }
function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 卡片内静默 */ } },
  }));
}

async function shopMod() { return import(SHOP_LIB + '?b=' + Date.now()); }
async function switchMod() { return import(SWITCH_LIB + '?b=' + Date.now()); }
async function personaMod() { return import(PERSONA_LIB + '?b=' + Date.now()); }

/** 当前群 id —— 走官方 ctx.event.peerId。 */
function gidOf(ctx) {
  const id = String(ctx?.event?.peerId || '');
  return /^[0-9A-Fa-f]{32}$/.test(id) ? id : '';
}

/** 当前群人格。 */
async function personaOf(gid) {
  // ★ 2026-11-24：状态里的人格名必须过归一化（含别名）再使用。
  //   原来直接返回原文，是全仓唯一不过 normalizePersonaName 的取人格路径；
  //   状态里存的是别名/文件名时，小店菜单与文案会按错误名字生成。
  try {
    const S = await switchMod();
    const g = S.groupState(S.loadState(), gid);
    const raw = String(g?.persona ?? '').trim();
    if (raw) {
      const P0 = await personaMod();
      const name = P0.normalizePersonaName(raw);
      if (name) return name;
    }
  } catch { /* ignore */ }
  try {
    const P = await personaMod();
    return P.defaultPersona(P.readConfig())?.name || '';
  } catch { /* ignore */ }
  return '';
}

async function makeShop() {
  const { createShop } = await shopMod();
  return createShop({
    dataRoot: SHOP_DATA,
    personaRoot: PERSONA_ROOT,
    cfg: {},
    logger: { warn: () => { /* 卡片里不打断用户 */ } },
  });
}

/** 兜底按钮：卡片没有按钮会被 QQ 拒发。 */
const FALLBACK_BUTTONS = [
  { id: 'main', label: '🔄 刷新', style: 1, botAction: { type: 'reply_text', text: '' } },
];

function setCard(ctx, text, buttons) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}

// ────────────────── 渲染 ──────────────────

function mainText(state, balance) {
  const items = Object.entries(state.dailyStock || {});
  const lines = [
    `## 🏪 ${state.shopName}`,
    '',
    `经营第 **${state.day}** 天 ｜ 当值：**${state.currentPersona || '?'}**`,
    (balance === null || balance === undefined)
      ? `今天已卖 **${state.soldToday || 0}** 份 ｜ 营收 **${state.dailyRevenue || 0}**`
      : `你的积分：**${balance}**　｜　今天已卖 ${state.soldToday || 0} 份`,
    '',
    '**【今日有货】**',
  ];
  if (items.length === 0) {
    lines.push('（没货了）');
  } else {
    // 常规商品与特供分开列（特供更醒目）
    const normal = items.filter(([n]) => !n.startsWith('今日特供·'));
    const special = items.filter(([n]) => n.startsWith('今日特供·'));

    for (const [name, v] of normal) {
      const qty = Number(v.qty) || 0;
      lines.push(`· ${name} ${qty > 0 ? `×${qty}` : '（卖完）'}　¥${v.price}`);
    }
    if (special.length > 0) {
      lines.push('', '**【今日特供】**');
      for (const [name, v] of special) {
        const qty = Number(v.qty) || 0;
        const shown = name.replace(/^今日特供·/, '');
        lines.push(`★ ${shown} ${qty > 0 ? '（限量 1 份）' : '（已售）'}　¥${v.price}`);
      }
    }
  }
  if (Array.isArray(state.recentEvents) && state.recentEvents.length > 0) {
    const last = state.recentEvents[state.recentEvents.length - 1];
    if (last?.text) lines.push('', '**【最近】**', last.text);
  }
  return lines.join('\n');
}

function mainBtns(state) {
  const hasStock = Object.values(state.dailyStock || {}).some((v) => (Number(v.qty) || 0) > 0);
  const btns = [];
  if (hasStock) btns.push({ id: 'order', label: '🥪 点单', style: 1, botAction: { type: 'reply_text', text: '' } });
  btns.push({ id: 'menu', label: '📋 菜单', style: 1, botAction: { type: 'reply_text', text: '' } });
  btns.push({ id: 'ledger', label: '📊 账本', style: 1, botAction: { type: 'reply_text', text: '' } });
  return btns;
}

function orderText(state) {
  const items = Object.entries(state.dailyStock || {}).filter(([, v]) => (Number(v.qty) || 0) > 0);
  const lines = ['## 🥪 点单', '', '点一下就能下单。', ''];
  if (items.length === 0) lines.push('（今天卖完了）');
  else for (const [name, v] of items) lines.push(`· ${name} ×${v.qty}　¥${v.price}`);
  return lines.join('\n');
}

function orderBtns(state) {
  const items = Object.entries(state.dailyStock || {}).filter(([, v]) => (Number(v.qty) || 0) > 0);
  const btns = items.slice(0, 5).map(([name]) => ({
    id: `buy:${encodeURIComponent(name)}`,
    label: `${name} ¥${state.dailyStock[name].price}`,
    style: 1,
    botAction: { type: 'reply_text', text: '' },
  }));
  btns.push({ id: 'main', label: '← 回店里', style: 0, botAction: { type: 'reply_text', text: '' } });
  return btns;
}

function ledgerText(state) {
  const lines = ['## 📊 账本', ''];
  lines.push(`经营第 **${state.day}** 天`);
  lines.push(`累计营收：**${state.totalRevenue || 0}**　累计卖出：**${state.totalSold || 0}** 份`);
  lines.push('', '**【今日】**', `卖出 ${state.soldToday || 0} 份，营收 ${state.dailyRevenue || 0}`);
  const sold = Object.entries(state.soldItems || {});
  if (sold.length > 0) lines.push(sold.map(([n, q]) => `${n}×${q}`).join('　'));
  if (state.stats?.bestDay) lines.push('', '**【最好的一天】**', `${state.stats.bestDay.date}：${state.stats.bestDay.revenue}`);
  if (state.stats?.topItem) lines.push('', '**【卖得最好】**', `${state.stats.topItem.name}（累计 ${state.stats.topItem.totalSold} 份）`);
  if (Array.isArray(state.personaHistory) && state.personaHistory.length > 1) {
    lines.push('', '**【谁管过这家店】**');
    for (const t of state.personaHistory.slice(-4)) {
      const span = t.to ? `${String(t.from).slice(0, 10)}~${String(t.to).slice(0, 10)}` : `${String(t.from).slice(0, 10)}起`;
      lines.push(`· ${t.persona}（${span}，${t.revenue || 0}）`);
    }
  }
  return lines.join('\n');
}

/** 渲染主卡（含首次开店）。返回是否成功。 */
async function renderMain(ctx, gid, shop) {
  let state = shop.snapshot(gid);
  if (!state) {
    const persona = await personaOf(gid);
    const r = await shop.open(gid, { personaName: persona });
    state = r.state || shop.snapshot(gid);
  }
  if (!state) {
    setCard(ctx, '## 🏪 小店\n\n店还没开起来。稍后再试。', FALLBACK_BUTTONS);
    return false;
  }
  // 取当前用户余额（拿不到就不显示，绝不阻断卡片）
  let balance = null;
  try {
    const openid = String(ctx?.user?.openid || '');
    if (openid) {
      const pts = await makePoints();
      balance = pts.balance(openid);
    }
  } catch { /* 积分服务不可用 → 不显示余额 */ }

  setCard(ctx, withClickerMention(ctx, mainText(state, balance)), mainBtns(state));
  return true;
}

// ────────────────── 卡片接口（官方契约）──────────────────

export default {
  name: '小店',

  async onInit(ctx) {
    // 非群聊 → 提示
    const scope = String(ctx?.event?.scope || '');
    if (scope && scope !== 'group') {
      setCard(ctx, '## 🏪 小店\n\n这个功能只能在群里用。', FALLBACK_BUTTONS);
      return;   // onInit 里不用置 dirty（框架首刷就是这张卡）
    }
    const gid = gidOf(ctx);
    if (!gid) {
      setCard(ctx, '## 🏪 小店\n\n定位不到这个群。', FALLBACK_BUTTONS);
      return;
    }
    try {
      const shop = await makeShop();
      await renderMain(ctx, gid, shop);
    } catch (e) {
      setCard(ctx, `## 🏪 小店\n\n开店失败：${e instanceof Error ? e.message : String(e)}`, FALLBACK_BUTTONS);
    }
  },

  async onClick(ctx, info) {
    const btn = String(info?.buttonId || '');
    const gid = gidOf(ctx);
    if (!gid) return '';

    let shop;
    try { shop = await makeShop(); } catch { return '小店暂时打不开。'; }

    // ── 回主卡 ──
    if (btn === 'main' || btn === '') {
      const ok = await renderMain(ctx, gid, shop);
      if (ok) ctx.card().dirty = true;   // 正文变了才刷新
      return '';
    }

    // ── 点单列表 ──
    if (btn === 'order') {
      const state = shop.snapshot(gid);
      if (!state) { await renderMain(ctx, gid, shop); ctx.card().dirty = true; return ''; }
      setCard(ctx, withClickerMention(ctx, orderText(state)), orderBtns(state));
      ctx.card().dirty = true;
      return '';
    }

    // ── 菜单 ──
    if (btn === 'menu') {
      const state = shop.snapshot(gid);
      if (!state) { await renderMain(ctx, gid, shop); ctx.card().dirty = true; return ''; }
      const lines = ['## 📋 菜单', ''];
      for (const [name, v] of Object.entries(state.dailyStock || {})) {
        lines.push(`· ${name}　¥${v.price}　${v.qty > 0 ? `剩 ${v.qty}` : '卖完'}`);
      }
      lines.push('', '（菜单每天换，跟着当值店长走）');
      setCard(ctx, withClickerMention(ctx, lines.join('\n')), [
        { id: 'main', label: '← 回店里', style: 0, botAction: { type: 'reply_text', text: '' } },
      ]);
      ctx.card().dirty = true;
      return '';
    }

    // ── 账本 ──
    if (btn === 'ledger') {
      const state = shop.snapshot(gid);
      if (!state) { await renderMain(ctx, gid, shop); ctx.card().dirty = true; return ''; }
      setCard(ctx, withClickerMention(ctx, ledgerText(state)), [
        { id: 'main', label: '← 回店里', style: 0, botAction: { type: 'reply_text', text: '' } },
      ]);
      ctx.card().dirty = true;
      return '';
    }

    // ── 点单：buy:<item> ──
    if (btn.startsWith('buy:')) {
      const item = decodeURIComponent(btn.slice(4));

      // ★ 官方 ctx.user（不再自己去 event 里翻 senderId）
      const openid = String(ctx?.user?.openid || '');
      const name = String(ctx?.user?.name || ctx?.user?.pureName || '');
      if (!openid) {
        setCard(ctx, '## 🥪 点单\n\n认不出你是谁，下不了单。', [
          { id: 'main', label: '← 回店里', style: 0, botAction: { type: 'reply_text', text: '' } },
        ]);
        ctx.card().dirty = true;
        return '';
      }

      // ══════════════════════════════════════════════════════════════════
      // ★★ 事务顺序（审查报告定的，防死锁）：
      //    ① 先扣积分（锁 openid，独立事务）
      //    ② 再扣库存（锁 gid，独立事务）
      //    ③ 库存失败 → 退款
      //    两把锁永不嵌套。
      // ══════════════════════════════════════════════════════════════════
      const FM = await formatMod();
      const preState = shop.snapshot(gid);
      const price = Number(preState?.dailyStock?.[item]?.price) || 0;

      let pts = null;
      let payRes = { ok: true, balance: 0, paid: 0 };
      if (price > 0) {
        try {
          pts = await makePoints();
          payRes = await pts.pay(openid, price, `买${item}`, name);
        } catch (e) {
          // 积分服务不可用 → 不让买（钱都算不清就别卖）
          //
          // ★ 2026-11-21 修（真 bug）：这里原来写 `catch {`，**完全静默**。
          //   而 POINTS_DATA 一度被误写成 `process.env.DSH_POINTS_ROOT`（无回退），
          //   环境变量不设 ⇒ undefined ⇒ createPoints 抛错 ⇒ 这里吞掉 ⇒
          //   用户看到「积分服务暂时不可用」，但日志里一个字都没有，排查极难。
          //   现在：1) POINTS_DATA 已改用 lib/dirs.mjs 的 POINTS_ROOT（含 env 覆盖）
          //        2) 错误写进诊断日志，下次一眼能定位
          const why = e instanceof Error ? e.message : String(e);
          try {
            const { appendFileSync, mkdirSync } = await import('node:fs');
            const { dirname } = await import('node:path');
            const { EXT_DATA } = await import('../lib/pack-paths.mjs');
            const f = `${EXT_DATA}/shop-points-error.log`;
            mkdirSync(dirname(f), { recursive: true });
            appendFileSync(f, `${new Date().toISOString()} 买${item} 时积分服务异常: ${why}\n`, 'utf8');
          } catch { /* 诊断失败不影响主流程 */ }
          payRes = { ok: false, reason: 'POINTS_UNAVAILABLE', balance: 0 };
        }
      }

      // ① 积分不够 → 直接拒绝，不扣库存
      if (!payRes.ok) {
        const st = shop.snapshot(gid);
        const why = payRes.reason === 'POINTS_UNAVAILABLE'
          ? '积分服务暂时不可用，先不卖了。'
          : `这个要 **${price}** 分，你只有 **${payRes.balance}** 分。`;
        setCard(ctx, withClickerMention(ctx,
          `## 💸 买不了\n\n${item}：${why}\n\n去 /签到 领一点？`,
        ), st ? orderBtns(st) : [
          { id: 'main', label: '← 回店里', style: 0, botAction: { type: 'reply_text', text: '' } },
        ]);
        ctx.card().dirty = true;
        return '';
      }

      // ② 扣库存
      const r = await shop.order(gid, { openid, name }, item, 1);

      // ③ 库存失败 → 退款
      if (!r.ok && payRes.paid > 0 && pts) {
        try { await pts.refund(openid, payRes.paid, `退款:${item}`, name); } catch { /* ignore */ }
      }

      const state = shop.snapshot(gid);
      const balance = r.ok
        ? Math.max(0, Number(payRes.balance) || 0)
        : Math.max(0, (Number(payRes.balance) || 0) + (payRes.paid || 0));

      let text;
      if (r.ok) {
        // 统一排版：消费行 + 余额
        const block = FM.formatPointsBlock({
          kind: 'shop', label: `买${item}`, delta: -price, balance,
          extra: [`📦 库存还剩 **${r.left}** 份`],
        });
        text = `## ✅ 下单成功\n\n${block}`;
      } else if (r.reason === 'SHOP_OUT_OF_STOCK') {
        text = `## 😔 卖完了\n\n${item} 今天没了。\n\n（**${price}** 积分已退回，余额 **${balance}**）`;
      } else if (r.reason === 'SHOP_ITEM_NOT_FOUND') {
        text = `## 🤔 没这个\n\n今天不做${item}。\n\n（**${price}** 积分已退回，余额 **${balance}**）`;
      } else {
        text = `## ⚠️ 下单失败\n\n${item} 没下成。\n\n（**${price}** 积分已退回，余额 **${balance}**）`;
      }

      setCard(ctx, withClickerMention(ctx, text), state ? orderBtns(state) : [
        { id: 'main', label: '← 回店里', style: 0, botAction: { type: 'reply_text', text: '' } },
      ]);
      ctx.card().dirty = true;
      // ★ 2026-11-17 移除 appendWake：卡片已写明扣分与余额，
      //   再唤醒 AI 会多发一条消息（同猜拳/骰子的问题）。
      return '';
    }

    // ── 未知点击 → 回主卡 ──
    const ok = await renderMain(ctx, gid, shop);
    if (ok) ctx.card().dirty = true;
    return '';
  },
};