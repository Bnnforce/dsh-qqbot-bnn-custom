// botplay 事件：猜拳（盲出）· 2026-11-09 新增
//
// 🔴 为什么要改写成事件卡片：
//   初版是斜杠命令直接回文本，而且**直接说出她出什么**（「我出石头。你出…」），
//   对方照着克制出必胜 —— 游戏等于没有。
//   现在照 `/随心配` 的做法：发一张带按钮的卡片，她的手**只存在服务端状态里**，
//   点按钮结算时才揭示。
//
// 状态：{dataRoot}/.qqbot-extensions/data/game-rps.json
//   { "<gid>:<cardId>": { hand, round, at } }
//   · hand  她这一局的盲注（卡片正文从不显示）
//   · round 局数（防旧消息上的按钮串局）
//   · at    开局时间（TTL 清理用）
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withClickerMention, clickerMention, formatCardText } from '../lib/pure/card-format.mjs';
import { navButtons, handleNavClick } from '../lib/pure/card-nav.mjs';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT } from '../lib/dirs.mjs';

// ★ 统一积分排版（单一真源在 pack 的 lib/points/format.mjs）
const FORMAT_LIB = `${EXT_ROOT}/lib/points/format.mjs`;
async function formatMod() { return import(FORMAT_LIB + '?f=' + Date.now()); }


const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// 测试隔离：允许环境变量覆盖（自动化测试用临时目录）
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）

async function pointsMod() { return import(POINTS_LIB + '?r=' + Date.now()); }
function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 静默 */ } },
  }));
}
const STATE_FILE = (ctx) => join(DATA_ROOT, '.qqbot-extensions', 'data', 'game-rps.json');
/** 状态 TTL：1 小时（卡片过期后状态必须回收，否则文件无限增长）。 */
const STATE_TTL_MS = 3600_000;

async function core(ctx) {
  return import(pathToFileURL(join(EXT_ROOT, 'lib', 'pure', 'game-core.mjs')).href + '?evt=' + Date.now());
}

/** 卡片状态 key：**每群每张卡各自独立**。 */
function keyOf(ctx) {
  const e = ctx?.event ?? {};
  return `${String(e.scope || '')}:${String(e.peerId || '')}:${String(ctx.cardId || '')}`;
}

function loadState(ctx) {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE(ctx), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

function saveState(ctx, st) {
  try {
    const file = STATE_FILE(ctx);
    mkdirSync(join(DATA_ROOT, '.qqbot-extensions', 'data'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch { /* 写失败不影响本局（内存里仍有） */ }
}

/** 清掉超过 TTL 的旧局（每次读写顺带清，不需要定时器）。 */
function prune(st, now = Date.now()) {
  let changed = false;
  for (const k of Object.keys(st)) {
    const v = st[k];
    if (!v || !(Number(v.at) + STATE_TTL_MS > now)) { delete st[k]; changed = true; }
  }
  return changed;
}

/** 开一局：定盲注 + 写状态。 */
async function startRound(ctx) {
  const C = await core(ctx);
  const st = loadState(ctx);
  prune(st);
  const k = keyOf(ctx);
  const prev = st[k];
  st[k] = {
    hand: C.pickBlindHand(),
    round: (Number(prev?.round) || 0) + 1,
    at: Date.now(),
  };
  saveState(ctx, st);
  return st[k];
}

/** 取当前局（不存在或已 TTL → undefined）。 */
function currentRound(ctx) {
  const st = loadState(ctx);
  const cleaned = prune(st);
  if (cleaned) saveState(ctx, st);
  return st[keyOf(ctx)];
}

function setCard(ctx, text, buttons) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}

export default {
  name: '猜拳',

  async onInit(ctx) {
    const C = await core(ctx);
    await startRound(ctx);
    // 卡片正文**不含她的手**（盲出）
    // ★ 2026-11-09：底部追加功能按钮（4 项，**不含猜拳自己**——它不在功能列表里）
    setCard(ctx, withClickerMention(ctx, C.rpsWaitingText()), [
      ...C.rpsHandButtons(),
      ...navButtons('rps'),
    ]);
    ctx.card().dirty = false;
  },

  async onClick(ctx, info) {
    const C = await core(ctx);
    const btn = String(info.buttonId || '');

    // ★ 功能按钮（日历/骰子/抽签/来张图）：直接调用对应功能的现有实现，本卡不变形
    const nav = await handleNavClick(ctx, btn);
    if (nav !== undefined) return nav;

    // ── 再来一局：换一个新的盲注，回到等待状态 ──
    if (btn === 'again') {
      await startRound(ctx);
      setCard(ctx, withClickerMention(ctx, C.rpsWaitingText()), [
        ...C.rpsHandButtons(),
        ...navButtons('rps'),
      ]);
      ctx.card().dirty = true;
      return '';
    }

    // ── 出拳：读盲注 → 结算 → 揭示 ──
    const hand = C.RPS_BUTTON_HAND[btn];
    if (!hand) return;

    const round = currentRound(ctx);
    if (!round || !round.hand) {
      // 状态丢了（TTL 过期 / 进程重启后文件没写成功）→ 重新开一局，不骗人
      await startRound(ctx);
      setCard(ctx, withClickerMention(ctx, C.rpsWaitingText()), [
        ...C.rpsHandButtons(),
        ...navButtons('rps'),
      ]);
      ctx.card().dirty = true;
      return formatCardText({ mention: clickerMention(ctx), body: '这一局过期了，重新开一局吧～' });
    }

    // ★ 积分结算（赢+2 / 平0 / 输−1）
    let pointsLine = '';
    try {
      const openid = String(ctx?.user?.openid || '');
      if (openid && typeof C.judgeRps === 'function') {
        // ★★ 视角转换（2026-11-17 修：截图暴露的真 bug）
        //   judgeRps(mine, theirs) 返回 'win' 表示 **mine 赢**。
        //   我们传的是 judgeRps(她的手, 用户的手)，所以返回值是「她赢」，
        //   而积分是给**用户**的 → 必须反转。
        //   不转的后果：用户赢了会显示 −1（扣到 0 变 0），AI 还会说"输了"。
        const herVerdict = C.judgeRps(round.hand, hand);
        const verdict = herVerdict === 'win' ? 'lose' : herVerdict === 'lose' ? 'win' : 'tie';
        const pts = await makePoints();
        const r = await pts.rps(openid, verdict, String(ctx?.user?.name || ''));
        const FM = await formatMod();
        if (r.ok) {
          // 统一排版：本局增减 + 余额 + 今日额度
          pointsLine = FM.appendPointsBlock({
            kind: 'rps', delta: r.delta, balance: r.balance, left: r.left, cap: 5,
          });
        } else {
          pointsLine = `\n\n${FM.pointsCappedLine('猜拳')}`;
        }
      }
    } catch { /* 积分服务坏 → 不影响游戏 */ }

    const reveal = C.rpsRevealText(round.hand, hand);
    setCard(ctx, withClickerMention(ctx, reveal + pointsLine), [
      ...C.rpsAgainButtons(),
      ...navButtons('rps'),
    ]);
    ctx.card().dirty = true;
    return '';
  },
};
