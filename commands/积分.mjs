/**
 * /积分 —— 积分查询与管理（2026-11-17）
 *
 * 用法：
 *   /积分          → 我的余额 + 今日状态
 *   /积分 排行      → 本群前 5
 *   /积分 清空      → 清空我的积分（需二次确认）
 *
 * ⚠️ 命令上下文用 ctx.caps.peerId（不是 ctx.event.peerId），已踩过坑。
 */
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT, GROUPS_JSON } from '../lib/dirs.mjs';

const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// ★ 测试隔离（2026-11-17）：允许用环境变量覆盖数据目录，
//   否则自动化测试会往生产目录写测试用户（已发生过一次污染）。
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）
const MEMBERS_LIB = `${EXT_ROOT}/lib/points/members.mjs`;
async function membersMod() { return import(MEMBERS_LIB + '?mb=' + Date.now()); }


async function pointsMod() { return import(POINTS_LIB + '?cmd=' + Date.now()); }

function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 静默 */ } },
  }));
}

/** 命令上下文的群 id 与人（沿用 card-kit 已验证口径）。 */
function peerOf(ctx) {
  const caps = ctx?.caps ?? {};
  const mc = ctx?.message ?? {};
  const gid = String(
    caps.peerId ?? mc.groupOpenid ?? mc.group_openid
    ?? ctx?.event?.peerId ?? '',
  );
  const uid = String(
    caps.actorOpenid ?? mc.author?.member_openid ?? mc.author?.user_openid
    ?? ctx?.user?.openid ?? '',
  );
  return {
    gid: /^[0-9A-Fa-f]{32}$/.test(gid) ? gid : '',
    uid,
  };
}

/** 尽力取群名。 */
async function groupNameOf(gid) {
  try {
    const { readFileSync } = await import('node:fs');
    const j = JSON.parse(readFileSync(GROUPS_JSON, 'utf8'));
    return String(j?.[gid]?.name || '');
  } catch { return ''; }
}

/**
 * 取本群成员（★ 2026-11-17 修：原来调的接口不存在，改用群台账）。
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

/**
 * 输出 markdown（含 `##` / `**` 的命令必须自己走 markdown 通道，
 * 否则 QQ 会把语法当字面文字显示）。
 */
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

export default {
  name: ['积分', 'points', 'jifen'],
  description: '积分：/积分 看余额；/积分 排行 看本群榜；/积分 清空 删档',
  usage: '/积分 [排行|清空]',

  async handler(ctx) {
    const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();
    const { gid, uid } = peerOf(ctx);

    if (!uid) return '认不出你是谁。';

    let pts;
    try { pts = await makePoints(); } catch (e) {
      return `积分服务打不开：${e instanceof Error ? e.message : String(e)}`;
    }

    // ── 排行榜 ──
    if (/排行|榜|rank|board/i.test(raw)) {
      if (pts.cfg.leaderboardEnabled !== true) return '排行榜关掉了。';
      const members = await membersOf(ctx, gid, uid);
      const rows = pts.leaderboard(members, { size: pts.cfg.leaderboardSize });
      const groupName = gid ? await groupNameOf(gid) : '';
      return await say(ctx, pts.renderBoard(rows, { groupName, selfOpenid: uid }));
    }

    // ── 清空 ──
    if (/清空|删除|clear|reset/i.test(raw)) {
      const st = await pts.status(uid);
      if (st.balance === 0 && !st.signedToday) return '你还没有积分，不用清。';
      // 二次确认：要求带 "确认" 二字
      if (!/确认/.test(raw)) {
        const tip = [
          `你现有 **${st.balance}** 积分。`,
          '',
          '真要清空，发：`/积分 清空 确认`',
          '（清空后余额归零，不可恢复）',
        ].join('\n');
        return await say(ctx, tip);
      }
      const done = pts.clear(uid);
      return done ? '积分已清空。' : '清空失败（可能本来就没有）。';
    }

    // ── 查余额（默认）──
    const st = await pts.status(uid);
    const lines = ['## 💰 我的积分', ''];
    lines.push(`余额：**${st.balance}**`);
    lines.push(`累计签到：**${st.totalDays}** 天`);
    lines.push('');
    lines.push('**【今天】**');
    lines.push(`· 签到：${st.signedToday ? '✅ 已签' : '❌ 未签'}`);
    lines.push(`· 抽签：${st.fortuneToday ? '✅ 已领' : '❌ 未领'}`);
    if (st.remaining) {
      lines.push(`· 猜拳：还能拿 ${st.remaining.rps || 0} 次`);
      lines.push(`· 骰子：还能拿 ${st.remaining.dice || 0} 次`);
    }
    lines.push('');
    lines.push('· `/积分 排行`　看本群榜');
    lines.push('· `/签到`　领今日 +5');
    return await say(ctx, lines.join('\n'));
  },
};