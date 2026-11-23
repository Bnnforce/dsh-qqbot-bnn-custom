// botplay 事件：骰子（2026-11-09 改卡片版）
//
// 主人要求：卡片式 + 显示「投到多少点」+ 按钮「再来一次」。
//
// 参数：botplay 事件本身拿不到斜杠命令的参数，所以卡片版默认掷 1d6。
//   需要复杂表达式（2d6、d20、3d10+2）时，仍可用斜杠命令：
//     `/骰子 2d6` → 走 commands/骰子.mjs（纯文本回，不走卡片）
//   这是**有意的分工**：卡片版给"随手一掷"，命令版给"指定骰子"。
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withClickerMention } from '../lib/pure/card-format.mjs';
import { navButtons, handleNavClick } from '../lib/pure/card-nav.mjs';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT } from '../lib/dirs.mjs';

// ★ 统一积分排版（单一真源在 pack 的 lib/points/format.mjs）
const FORMAT_LIB = `${EXT_ROOT}/lib/points/format.mjs`;
async function formatMod() { return import(FORMAT_LIB + '?f=' + Date.now()); }


const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// 测试隔离：允许环境变量覆盖（自动化测试用临时目录）
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）

async function pointsMod() { return import(POINTS_LIB + '?d=' + Date.now()); }
function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 静默 */ } },
  }));
}

async function core(ctx) {
  return import(pathToFileURL(join(EXT_ROOT, 'lib', 'pure', 'game-core.mjs')).href + '?evt=' + Date.now());
}

/** 读配置（拿不到就用默认值，绝不让卡片失效）。 */
async function loadCfg(ctx, C) {
  try {
    const { readFileSync } = await import('node:fs');
    const file = join(DATA_ROOT, '.qqbot-extensions', 'data', 'game-config.json');
    return C.resolveConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return C.resolveConfig(C.DEFAULT_CONFIG);
  }
}

function setCard(ctx, text, buttons) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}

/** 掷一次并刷新卡片。 */
async function roll(ctx, mention = '') {
  const C = await core(ctx);
  const cfg = await loadCfg(ctx, C);
  const data = C.rollDiceData('', cfg);   // 默认 1d6
  // ★ 全局：@操作者 单独一行 + 空行，再给 markdown 正文（否则卡片格式失效）
  // ★ 2026-11-09：底部追加功能按钮（**不含自己**的「🎲 骰子」）
  setCard(ctx, withClickerMention(ctx, C.diceCardText(data)), [
    ...C.diceAgainButtons(),
    ...navButtons('dice'),
  ]);
  return data;
}

/**
 * 掷一次并结算积分，把积分块追加到卡片正文。
 *
 * ★ 2026-11-17 修（主人报）：从别的卡片点「🎲 骰子」跳过来不加积分。
 *   根因：原来只在 onClick 的「再来一次」发分，而**打开卡片本身也是一次投掷**
 *   （onInit 里就 roll 了）→ 打开也该发分，否则跳转路径永远拿不到分。
 *
 * @returns {Promise<string>} 追加到正文的积分块（可能为空）
 */
async function rollAndAward(ctx) {
  await roll(ctx);
  let block = '';
  try {
    const openid = String(ctx?.user?.openid || '');
    if (openid) {
      const pts = await makePoints();
      const r = await pts.dice(openid, String(ctx?.user?.name || ''));
      const FM = await formatMod();
      block = r.ok
        ? FM.appendPointsBlock({ kind: 'dice', delta: r.delta, balance: r.balance, left: r.left, cap: 5 })
        : `\n\n${FM.pointsCappedLine('骰子')}`;
    }
  } catch { /* 积分服务坏 → 不影响游戏 */ }

  if (block) {
    try {
      const c = ctx.card();
      c.contentText = String(c.contentText || '') + block;
    } catch { /* ignore */ }
  }
  return block;
}

export default {
  name: '骰子',

  async onInit(ctx) {
    // ★ 打开卡片 = 掷一次 = 算一次玩法，所以要发分
    await rollAndAward(ctx);
    ctx.card().dirty = false;
  },

  async onClick(ctx, info) {
    const btn = String(info.buttonId || '');
    // ★ 功能按钮（日历/抽签/来张图）：直接调用对应功能的现有实现，本卡不再变形
    const nav = await handleNavClick(ctx, btn);
    if (nav !== undefined) return nav;
    if (btn !== 'again') return;

    // 「再来一次」= 再掷一次 = 再算一次玩法
    await rollAndAward(ctx);
    ctx.card().dirty = true;
    return '';
  },
};
