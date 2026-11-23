// botplay 事件：抽签（2026-11-09 改卡片版）
//
// 主人要求：卡片式 + **先说吉还是凶** + 再补一句话 + 按钮「再抽一签」。
//
// 签等（2026-11-09 第三轮）：七档 + 1-10 分
//   大吉(9-10) / 中吉(8) / 小吉(7) / 末吉(6) / 平(5) / 小凶(3-4) / 凶(1-2)
//   ⚠️ 演进史：第一轮"不做凶档" → 第二轮"先说吉凶"(仍无凶) → 第三轮**正式加凶档+分数**。
//      有 1-10 分之后，凶档是"今天运气 2 分"的量化表达，不是诅咒；配上金句签文仍是图个乐。
//
// 签文来源：**外部金句库**（`人格/每日金句.txt`，300+ 条）> 内置回退。
//   主人要求「金句库给抽签用」—— 原"今日金句"功能已移除，那批温柔的话正好当签文。
//
// 不落状态：抽签没有「盲出」需求，每次点按钮现抽即可。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withClickerMention } from '../lib/pure/card-format.mjs';
import { navButtons, handleNavClick } from '../lib/pure/card-nav.mjs';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT } from '../lib/dirs.mjs';


const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// 测试隔离：允许环境变量覆盖（自动化测试用临时目录）
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）

// ★ 统一积分排版（单一真源在 pack 的 lib/points/format.mjs）
const FORMAT_LIB = `${EXT_ROOT}/lib/points/format.mjs`;
async function formatMod() { return import(FORMAT_LIB + '?f=' + Date.now()); }

async function pointsMod() { return import(POINTS_LIB + '?f=' + Date.now()); }
function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 静默 */ } },
  }));
}

async function core(ctx) {
  return import(pathToFileURL(join(EXT_ROOT, 'lib', 'pure', 'game-core.mjs')).href + '?evt=' + Date.now());
}

function setCard(ctx, text, buttons) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}

/** 加载签文库（外部金句库优先；失败自动回退内置，绝不抛）。 */
function fortuneLines(C, ctx) {
  return C.loadFortuneLines({
    root: DATA_ROOT,
    join,
    readFile: readFileSync,
  });
}

/** 抽一签并刷新卡片（**一天一种**：seed = 日期键 | 用户身份）。 */
async function draw(ctx) {
  const C = await core(ctx);
  // ★ 2026-11-09 第四轮：按「日期 + 用户」派生确定性种子 → 同一天同一人永远同一签。
  //   没有身份时（理论上不会发生）退化为「日期 + 群」，至少同群同天一致。
  const uid = String(ctx?.user?.openid ?? '').trim();
  const gid = String(ctx?.event?.peerId ?? '').trim();
  const dateKey = C.fortuneDateKey(Date.now());
  const seed = `${dateKey}|${uid || gid || 'anon'}`;
  const drawn = C.drawFortune({ seed, lines: fortuneLines(C, ctx) });
  // ★ 抽签按星级发积分（一天一次，按 dateKey 判重）
  let awardLine = '';
  try {
    const openid = String(ctx?.user?.openid || '');
    if (openid) {
      const pts = await makePoints();
      const r = await pts.fortune(openid, drawn.score, drawn.dateKey, String(ctx?.user?.name || ''));
      if (r.ok) {
        // ★ 统一排版（单一真源：lib/points/format.mjs）
        const FM = await formatMod();
        awardLine = FM.appendPointsBlock({
          kind: 'fortune', delta: r.points, balance: r.balance,
          extra: r.points === 0 ? ['（凶签，不给分）'] : [],
        });
      }
    }
  } catch { /* 积分服务坏 → 不影响抽签 */ }

  // ★ 全局：@操作者 单独一行 + 空行，再给 markdown 正文
  setCard(ctx, withClickerMention(ctx, C.fortuneCardText(drawn) + awardLine), [
    ...C.fortuneAgainButtons(),
    ...navButtons('fortune'),
  ]);
  return drawn;
}

export default {
  name: '抽签',

  async onInit(ctx) {
    await draw(ctx);
    ctx.card().dirty = false;
  },

  async onClick(ctx, info) {
    const btn = String(info.buttonId || '');
    // ★ 功能按钮（日历/骰子/来张图）：直接调用对应功能的现有实现，本卡不再变形
    const nav = await handleNavClick(ctx, btn);
    if (nav !== undefined) return nav;
    if (btn !== 'again') return;
    await draw(ctx);
    ctx.card().dirty = true;
    return '';
  },
};
