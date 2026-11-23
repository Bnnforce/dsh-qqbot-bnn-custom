/**
 * botplay/daily-checkin — 每日签到卡（2026-11-17）
 *
 * ⚠️ 卡片接口（官方契约 docs/botplay-contract.md）：
 *   export default { name, onInit(ctx), onClick(ctx, info) }
 *
 * 设计要点：
 *   · 不主动推送（避免任务感 —— 主人明确否决过"催签到"）
 *   · 用 ctx.user 取人，用 ctx.emit 提示（不唤醒 AI，避免重复消息）
 *   · 只有按钮状态真变了才 card().dirty = true
 */
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT } from '../lib/dirs.mjs';

const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
// ★ 测试隔离（2026-11-17）：允许用环境变量覆盖数据目录，
//   否则自动化测试会往生产目录写测试用户（已发生过一次污染）。
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）

const FORMAT_LIB = `${EXT_ROOT}/lib/points/format.mjs`;
async function formatMod() { return import(FORMAT_LIB + '?f=' + Date.now()); }

async function pointsMod() { return import(POINTS_LIB + '?ck=' + Date.now()); }

function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 卡片里不打断 */ } },
  }));
}

/** 兜底按钮：卡片没有按钮会被 QQ 拒发，错误分支也必须给一个。 */
const FALLBACK_BUTTONS = [
  { id: 'retry', label: '🔄 重试', style: 1, botAction: { type: 'reply_text', text: '' } },
];

function setCard(ctx, text, buttons = []) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}

function btn(id, label, style = 1) {
  return { id, label, style, botAction: { type: 'reply_text', text: '' } };
}

/**
 * 渲染签到卡正文（2026-11-17 统一排版）。
 *
 * 布局：
 *   标题
 *   余额 · 连续天数            ← 一眼看到自己的钱和坚持
 *   今日奖励 / 已签提示
 *   今天还能做什么（抽签/猜拳/骰子剩余）
 */
function renderText(status, cfg) {
  const lines = ['## 📅 每日签到', ''];

  // 第一行：余额 + 连续天数（最重要的两个数）
  lines.push(`💰 余额 **${status.balance}**　·　🔥 连续 **${status.totalDays}** 天`);

  if (status.signedToday) {
    lines.push('');
    lines.push('**今日已签**　明天再来。');
  } else {
    lines.push('');
    lines.push(`**今日奖励 +${cfg.checkinPoints}**`);
  }

  // 今天还能做什么
  const bits = [];
  if (!status.fortuneToday) bits.push('🎴 抽签');
  if (Number(status.remaining?.rps) > 0) bits.push(`✊ 猜拳 ×${status.remaining.rps}`);
  if (Number(status.remaining?.dice) > 0) bits.push(`🎲 骰子 ×${status.remaining.dice}`);
  if (bits.length > 0) {
    lines.push('');
    lines.push('**今天还能：**');
    lines.push(bits.join('　'));
  }

  return lines.join('\n');
}

export default {
  name: '签到',

  async onInit(ctx) {
    try {
      const pts = await makePoints();
      const openid = String(ctx?.user?.openid || '');
      if (!openid) {
        setCard(ctx, '## 📅 每日签到\n\n认不出你是谁。', FALLBACK_BUTTONS);
        return;
      }
      const status = await pts.status(openid);
      setCard(
        ctx,
        renderText(status, pts.cfg),
        status.signedToday ? [] : [btn('checkin', '✅ 签到')],
      );
    } catch (e) {
      setCard(ctx, `## 📅 每日签到\n\n暂时用不了：${e instanceof Error ? e.message : String(e)}`, FALLBACK_BUTTONS);
    }
  },

  async onClick(ctx, info) {
    const btnId = String(info?.buttonId || '');
    if (btnId !== 'checkin') return '';

    const openid = String(ctx?.user?.openid || '');
    const name = String(ctx?.user?.name || ctx?.user?.pureName || '');
    if (!openid) return '认不出你是谁。';

    try {
      const pts = await makePoints();
      const r = await pts.checkin(openid, name);

      if (r.ok) {
        const status = await pts.status(openid);
        const FM = await formatMod();
        // 统一排版：签到行 + 余额 + 连续天数
        const block = FM.formatPointsBlock({
          kind: 'checkin', delta: r.points, balance: r.balance,
          extra: [`🔥 连续 **${r.totalDays}** 天`],
        });
        setCard(ctx, [
          '## ✅ 签到成功',
          '',
          block,
          '',
          status.signedToday ? '明天再来。' : '',
        ].filter((x) => x !== '').join('\n'), FALLBACK_BUTTONS);
        ctx.card().dirty = true;   // 按钮消失，必须刷新
        // ★ 2026-11-17 移除 appendWake：卡片已写明结果，
        //   再唤醒 AI 会**多发一条消息**（同猜拳/骰子的问题）。
        return '';
      }

      if (r.reason === 'ALREADY') {
        ctx.emit('今天已经签过了。');
        return '';
      }
      ctx.emit('签到没成功。');
      return '';
    } catch (e) {
      ctx.emit(`签到失败：${e instanceof Error ? e.message : String(e)}`);
      return '';
    }
  },
};