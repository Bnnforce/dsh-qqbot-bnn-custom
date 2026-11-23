/**
 * /签到 —— 每日签到入口（2026-11-17）
 *
 * 打开「签到」卡片（botplay/daily-checkin.mjs）。
 * 卡片打不开时降级为纯文本（直接结算并返回结果）。
 *
 * ⚠️ 命令上下文用 ctx.caps.peerId / ctx.caps.actorOpenid，
 *    不是 ctx.event.peerId（踩过坑）；fireCard 已封装好。
 */
import { fireCard, commandPeer } from '../lib/pure/card-kit.mjs';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT } from '../lib/dirs.mjs';

const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// ★ 测试隔离（2026-11-17）：允许用环境变量覆盖数据目录，
//   否则自动化测试会往生产目录写测试用户（已发生过一次污染）。
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）

async function pointsMod() { return import(POINTS_LIB + '?ck=' + Date.now()); }

function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 命令内静默 */ } },
  }));
}

/** 输出 markdown（含 ## / ** 必须自己走 markdown 通道）。 */
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
  name: ['签到', 'checkin', 'qiandao'],
  description: '每日签到：+5 积分',
  usage: '/签到',

  async handler(ctx) {
    // 首选：发签到卡（按钮交互体验更好）
    if (await fireCard(ctx, 'daily-checkin')) return '';

    // ── 降级：卡片系统不可用 → 直接结算并回文本 ──
    const { uid } = commandPeer(ctx);
    const openid = String(uid || '').trim();
    if (!openid) return await say(ctx, '认不出你是谁，签不了。');

    let pts;
    try {
      pts = await makePoints();
    } catch (e) {
      return await say(ctx, `积分服务打不开：${e instanceof Error ? e.message : String(e)}`);
    }

    const r = await pts.checkin(openid, String(ctx?.user?.name || ''));
    const st = await pts.status(openid);

    if (r.ok) {
      return await say(ctx, [
        '## ✅ 签到成功',
        '',
        `🌟 获得积分：**+${r.points}**`,
        `💎 当前余额：**${r.balance}**`,
        `🔥 累计签到：**${r.totalDays}** 天`,
      ].join('\n'));
    }

    if (r.reason === 'ALREADY') {
      return await say(ctx, [
        '## 📅 今天已经签过了',
        '',
        `💎 当前余额：**${st.balance}**`,
        `🔥 累计签到：**${st.totalDays}** 天`,
        '',
        '明天再来。',
      ].join('\n'));
    }

    return await say(ctx, '签到没成功，稍后再试。');
  },
};