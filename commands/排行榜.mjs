/**
 * /排行榜 —— 本群积分排行榜（2026-11-17）
 *
 * 打开「排行榜」卡片（botplay/points-board.mjs）。
 * 卡片打不开时降级为纯文本榜。
 */
import { fireCard } from '../lib/pure/card-kit.mjs';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT, GROUPS_JSON } from '../lib/dirs.mjs';

const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// ★ 测试隔离（2026-11-17）：允许用环境变量覆盖数据目录，
//   否则自动化测试会往生产目录写测试用户（已发生过一次污染）。
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）
const MEMBERS_LIB = `${EXT_ROOT}/lib/points/members.mjs`;
async function membersMod() { return import(MEMBERS_LIB + '?mb=' + Date.now()); }


async function pointsMod() { return import(POINTS_LIB + '?lb=' + Date.now()); }

function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 静默 */ } },
  }));
}

function peerOf(ctx) {
  const caps = ctx?.caps ?? {};
  const mc = ctx?.message ?? {};
  const gid = String(caps.peerId ?? mc.groupOpenid ?? mc.group_openid ?? ctx?.event?.peerId ?? '');
  const uid = String(
    caps.actorOpenid ?? mc.author?.member_openid ?? mc.author?.user_openid
    ?? ctx?.user?.openid ?? '',
  );
  return { gid: /^[0-9A-Fa-f]{32}$/.test(gid) ? gid : '', uid };
}

async function say(ctx, md) {
  const caps = ctx?.caps ?? ctx;
  if (typeof caps?.markdown === 'function') {
    try {
      const ok = await caps.markdown(md);
      if (ok) return '';
    } catch { /* 落到返回文本 */ }
  }
  return md;
}

async function groupNameOf(gid) {
  try {
    const { readFileSync } = await import('node:fs');
    const j = JSON.parse(readFileSync(GROUPS_JSON, 'utf8'));
    return String(j?.[gid]?.name || '');
  } catch { return ''; }
}

/**
 * 取本群成员（★ 2026-11-17 修：原来调的 /v2/groups/{gid}/members **接口不存在**，
 * 永远失败 → 只能显示自己。改用群台账 .qqbot/msg-history/）。
 */
async function membersOf(ctx, gid, selfId) {
  const caps = ctx?.caps ?? ctx ?? {};
  const qqbotRoot = String(caps.dataRoot || caps.qqbotDataRoot || '').trim()
    || DATA_ROOT;
  try {
    const M = await membersMod();
    return await M.memberOpenids({ qqbotRoot, gid, selfOpenid: selfId, api: ctx?.api });
  } catch {
    return selfId ? [selfId] : [];
  }
}

export default {
  name: ['排行榜', '积分榜', 'rank', 'paihangbang', 'pointsboard'],
  description: '本群积分排行榜（只显示本群）',
  usage: '/排行榜',

  async handler(ctx) {
    // 首选：发排行榜卡
    if (await fireCard(ctx, 'points-board')) return '';

    // ── 降级：纯文本榜 ──
    const { gid, uid } = peerOf(ctx);
    if (!uid) return await say(ctx, '认不出你是谁。');

    let pts;
    try {
      pts = await makePoints();
    } catch (e) {
      return await say(ctx, `积分服务打不开：${e instanceof Error ? e.message : String(e)}`);
    }
    if (pts.cfg.leaderboardEnabled !== true) return await say(ctx, '排行榜关掉了。');

    const members = await membersOf(ctx, gid, uid);
    const rows = pts.leaderboard(members, { size: pts.cfg.leaderboardSize });
    const groupName = gid ? await groupNameOf(gid) : '';
    return await say(ctx, pts.renderBoard(rows, { groupName, selfOpenid: uid }));
  },
};