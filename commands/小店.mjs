/**
 * /小店 —— 打开小店卡片（2026-11-17）
 *
 * 用法：
 *   /小店          → 提示怎么打开（斜杠命令拿不到「发卡片」能力）
 *   /小店 状态      → 纯文本看店铺现状
 *   /小店 账本      → 纯文本看经营统计
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 为什么 /小店 不能直接弹卡片（实测 2026-11-17）：
 *
 *   botplay 卡片只能由**插件内部**的 triggerBotplay() 触发，
 *   那是 @zaofan/dsh-qqbot 的模块级注册表，扩展包（.mjs）import 不到。
 *
 *   现有 `/骰子` 走卡片，是因为它通过 lib/game-command.mjs 的专用通道 ——
 *   那个通道内部也是调 triggerBotplay，但**只在插件自己的 commands 目录生效**。
 *
 *   所以本命令的策略是：
 *     · 告诉用户用 `/botplay shop`（这是唯一能发卡片的入口）
 *     · 同时提供纯文本查询（状态/账本），不用发卡片也能看
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// ★ 2026-11-17 统一：卡片触发走 card-kit，不再自己抄一遍
import { fireCard, commandPeer } from '../lib/pure/card-kit.mjs';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { SHOP_ROOT, PERSONA_ROOT } from '../lib/dirs.mjs';

const SHOP_LIB = `${EXT_ROOT}/lib/shop/index.mjs`;
const SWITCH_LIB = `${EXT_ROOT}/lib/io/persona-switch.mjs`;
// 测试隔离：允许环境变量覆盖（自动化测试用临时目录）
const SHOP_DATA = SHOP_ROOT;


async function shopMod() { return import(SHOP_LIB + '?cmd=' + Date.now()); }
async function switchMod() { return import(SWITCH_LIB + '?cmd=' + Date.now()); }

/** 从 groups.json 取群名（拿不到返回空）。 */
async function groupNameOf(gid) {
  try {
    const { readFileSync } = await import("node:fs");
    // ★ 2026-11-20 修：原来写死 /absolute/path/... 绝对路径 ⇒ 换机/测试隔离全失效
    const j = JSON.parse(readFileSync(join(DATA_ROOT, '.qqbot', 'groups.json'), "utf8"));
    const rec = j?.[gid];
    return String(rec?.name || "");
  } catch { return ""; }
}

async function personaOf(gid) {
  try {
    const S = await switchMod();
    const g = S.groupState(S.loadState(), gid);
    if (g?.persona) return String(g.persona);
  } catch { /* ignore */ }
  return '';
}

async function makeShop() {
  const { createShop } = await shopMod();
  return createShop({
    dataRoot: SHOP_DATA,
    personaRoot: PERSONA_ROOT,
    cfg: {},
    logger: { warn: () => { /* 命令里不打断 */ } },
  });
}

/** 纯文本：店铺现状。 */
function statusText(state) {
  const items = Object.entries(state.dailyStock || {});
  const lines = [
    `🏪 ${state.shopName}`,
    '',
    `经营第 ${state.day} 天　当值：${state.currentPersona || '?'}`,
    `今天已卖 ${state.soldToday || 0} 份，营收 ${state.dailyRevenue || 0}`,
    '',
    '【今日有货】',
  ];
  if (items.length === 0) lines.push('（没货了）');
  else {
    for (const [name, v] of items) {
      const qty = Number(v.qty) || 0;
      lines.push(`· ${name} ${qty > 0 ? `×${qty}` : '（卖完）'}　¥${v.price}`);
    }
  }
  if (!state.openToday) lines.push('', '（今天还没开门）');
  return lines.join('\n');
}

/** 纯文本：账本。 */
function ledgerText(state) {
  const lines = [
    `📊 ${state.shopName} · 账本`,
    '',
    `经营第 ${state.day} 天`,
    `累计营收 ${state.totalRevenue || 0}　累计卖出 ${state.totalSold || 0} 份`,
    '',
    '【今日】',
    `卖出 ${state.soldToday || 0} 份，营收 ${state.dailyRevenue || 0}`,
  ];
  const sold = Object.entries(state.soldItems || {});
  if (sold.length > 0) lines.push(sold.map(([n, q]) => `${n}×${q}`).join('　'));
  if (state.stats?.bestDay) {
    lines.push('', '【最好的一天】', `${state.stats.bestDay.date}：${state.stats.bestDay.revenue}`);
  }
  if (state.stats?.topItem) {
    lines.push('', '【卖得最好】', `${state.stats.topItem.name}（累计 ${state.stats.topItem.totalSold} 份）`);
  }
  if (Array.isArray(state.personaHistory) && state.personaHistory.length > 1) {
    lines.push('', '【谁管过这家店】');
    for (const t of state.personaHistory.slice(-4)) {
      const span = t.to ? `${String(t.from).slice(0, 10)}~${String(t.to).slice(0, 10)}` : `${String(t.from).slice(0, 10)}起`;
      lines.push(`· ${t.persona}（${span}，${t.revenue || 0}）`);
    }
  }
  return lines.join('\n');
}

export default {
  name: ['小店', 'shop', 'xiaodian'],
  description: '小店：/小店 看状态；/小店 账本 看统计；点卡片用 /botplay shop',
  usage: '/小店 [状态|账本|卡片]',

  async handler(ctx) {
    const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();
    const { gid } = commandPeer(ctx);

    if (!gid) return '小店只能在群里看。';

    let shop;
    try { shop = await makeShop(); } catch (e) {
      return `小店打不开：${e instanceof Error ? e.message : String(e)}`;
    }

    const state = shop.snapshot(gid);

    // ── 无参数：优先发卡片（和 /骰子 同一套做法）──
    if (!raw) {
      const sent = await fireCard(ctx, 'shop');
      if (sent) return '';   // 卡片已发出，不再回文本
      // 卡片发不出去 → 落回纯文本（绝不让命令没反应）

      if (!state) {
        // 还没开店 → 顺手开一次
        const persona = await personaOf(gid);
        const groupName = await groupNameOf(gid);
        const r = await shop.open(gid, { personaName: persona, groupName });
        if (r.ok) return statusText(r.state);
        return `小店还没开起来（${r.reason || '未知原因'}）。`;
      }
      return `${statusText(state)}\n\n· /小店 账本　看经营统计`;
    }

    // ── 账本 ──
    if (/账本|ledger|统计/i.test(raw)) {
      if (!state) return '店还没开，没有账。';
      return ledgerText(state);
    }

    // ── 卡片提示 ──
    if (/卡片|card/i.test(raw)) {
      return '发 /botplay shop 就能打开卡片小店的卡片（能点单、能看菜单）。';
    }

    // ── 状态（含其他任何参数）──
    if (!state) return '店还没开。发 /小店 开一次。';
    return statusText(state);
  },
};