/**
 * botplay/points-board — 本群排行榜（2026-11-17）
 *
 * ⚠️ 卡片接口（官方契约）：export default { name, onInit, onClick }
 *
 * 隐私红线（硬性）：
 *   · **只显示本群成员**，不跨群
 *   · 不显示"在几个群活跃"
 *   · 可配置关闭（leaderboardEnabled）
 *
 * 数据来源：ctx.api 查群成员 → 只对有积分档案的人排序。
 * 拿不到成员列表时，降级为"只显示你自己"。
 */
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT } from '../lib/dirs.mjs';

const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// ★ 测试隔离（2026-11-17）：允许用环境变量覆盖数据目录，
//   否则自动化测试会往生产目录写测试用户（已发生过一次污染）。
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）

const MEMBERS_LIB = `${EXT_ROOT}/lib/points/members.mjs`;
async function membersMod() { return import(MEMBERS_LIB + '?mb=' + Date.now()); }

async function pointsMod() { return import(POINTS_LIB + '?pb=' + Date.now()); }

function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 静默 */ } },
  }));
}

/**
 * 排行榜卡必须至少有一个按钮 —— QQ 的 botplay 卡片没有按钮会直接拒发，
 * 报「事件没有可用按钮(模块没给出按钮，且事件里也没配 buttons)」。
 * 排行榜是只读列表，所以给一个「刷新」按钮。
 */
const BOARD_BUTTONS = [
  { id: 'refresh', label: '🔄 刷新', style: 1, botAction: { type: 'reply_text', text: '' } },
];

function setCard(ctx, text, buttons = []) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}

/**
 * 取本群成员 openid（★ 2026-11-17 修）。
 *
 * 原实现调 `ctx.api('/v2/groups/{gid}/members')` —— **这个接口不存在**
 * （官方只有单个 getMemberInfo，且还是关门状态）⇒ 永远失败 ⇒
 * 排行榜只能显示点击者自己，看起来像"还没有人有积分"。
 *
 * 现在优先用**群台账** `.qqbot/msg-history/group_<gid>/`（每人的 openid+昵称都在）。
 */
async function memberOpenids(ctx, gid) {
  const selfId = String(ctx?.user?.openid || '');
  // ★ 2026-11-20 修 P1：原来用 String(ctx.dir).split('.qqbot-extensions')[0] 反推数据根。
  //   问题：① botplay 的 ctx.dir 被官方固定在 {dataRoot}/.qqbot-extensions/botplay，
  //          但不是所有部署都这样（内置树/包内加载时可能变）；
  //        ② 路径里一旦没有 '.qqbot-extensions' 字样，split 返回原文 → 拿到错根。
  //   现在直接用 pack-paths 的 DATA_ROOT（含 QQBOT_DATA_ROOT 覆盖）。
  const qqbotRoot = DATA_ROOT;
  try {
    const M = await membersMod();
    return await M.memberOpenids({
      qqbotRoot, gid, selfOpenid: selfId, api: ctx?.api,
    });
  } catch {
    return selfId ? [selfId] : [];
  }
}

export default {
  name: '排行榜',

  async onInit(ctx) {
    try {
      const pts = await makePoints();
      if (pts.cfg.leaderboardEnabled !== true) {
        setCard(ctx, '## 📊 排行榜\n\n这个功能关掉了。', BOARD_BUTTONS);
        return;
      }
      const gid = String(ctx?.event?.peerId || '');
      const selfId = String(ctx?.user?.openid || '');
      const members = await memberOpenids(ctx, gid);
      const rows = pts.leaderboard(members, { size: pts.cfg.leaderboardSize });
      const text = pts.renderBoard(rows, { selfOpenid: selfId });
      setCard(ctx, text, BOARD_BUTTONS);
    } catch (e) {
      setCard(ctx, `## 📊 排行榜\n\n暂时看不到：${e instanceof Error ? e.message : String(e)}`, BOARD_BUTTONS);
    }
  },

  async onClick(ctx, info) {
    // 只有一个按钮：刷新
    if (String(info?.buttonId || '') === 'refresh') {
      await this.onInit(ctx);
      ctx.card().dirty = true;
      return '';
    }
    return '';
  },
};