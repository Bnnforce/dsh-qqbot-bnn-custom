/**
 * /抽奖 —— 花积分抽一次奖（2026-11-18 R5.1 积分出口）
 *
 * 价格：**30 分**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 事务顺序（与审查报告一致）：
 *   ① 先扣分（锁 openid，独立事务）
 *   ② 再执行出口业务
 *   ③ 出口失败 → 退款
 *
 * 为什么不能反：出口业务可能耗时/失败，先执行再扣分会出现"白拿"。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { commandPeer } from '../lib/pure/card-kit.mjs';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { POINTS_ROOT } from '../lib/dirs.mjs';

const POINTS_LIB = `${EXT_ROOT}/lib/points/index.mjs`;
const OUTLETS_LIB = `${EXT_ROOT}/lib/points/outlets/index.mjs`;
const SWITCH_LIB = `${EXT_ROOT}/lib/io/persona-switch.mjs`;
// 测试隔离：允许环境变量覆盖数据目录
const POINTS_DATA = POINTS_ROOT; // 由 lib/dirs.mjs 统一（含 env 覆盖）

async function pointsMod() { return import(POINTS_LIB + '?o=' + Date.now()); }
async function outletsMod() { return import(OUTLETS_LIB + '?o=' + Date.now()); }
async function switchMod() { return import(SWITCH_LIB + '?o=' + Date.now()); }

function makePoints() {
  return pointsMod().then(({ createPoints }) => createPoints({
    dataRoot: POINTS_DATA,
    logger: { warn: () => { /* 命令内静默 */ } },
  }));
}

/** 当前群人格（用于人格化文案）。 */
async function personaOf(gid) {
  try {
    const S = await switchMod();
    const g = S.groupState(S.loadState(), gid);
    if (g?.persona) return String(g.persona);
  } catch { /* ignore */ }
  return '';
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

export default {
  name: ["抽奖","lottery","choujiang"],
  description: '花积分抽一次奖（30 分）',
  usage: '/抽奖',

  async handler(ctx) {
    const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();
    const { gid, uid } = commandPeer(ctx);
    if (!uid) return await say(ctx, '认不出你是谁。');

    let pts, outlets;
    try {
      pts = await makePoints();
      outlets = await outletsMod();
    } catch (e) {
      return await say(ctx, `积分服务打不开：${e instanceof Error ? e.message : String(e)}`);
    }

    const outlet = outlets.outletOf('lottery');
    if (!outlet || outlet.enabled === false) return await say(ctx, '这个功能关了。');

    const price = outlets.priceOf(outlet, pts.cfg);
    const persona = gid ? await personaOf(gid) : '';

    // ① 先扣分
    const payRes = await pts.pay(uid, price, `抽奖`, String(ctx?.user?.name || ''));
    if (!payRes.ok) {
      return await say(ctx, [
        '## 💸 积分不够',
        '',
        `花积分抽一次奖要 **${price}** 分，你只有 **${payRes.balance}**。`,
        '',
        '去 /签到 领一点？',
      ].join('\n'));
    }

    // ② 执行出口
    let r;
    try {
      r = await outlet.run({ pts, openid: uid, name: String(ctx?.user?.name || ''), gid, persona, args: raw });
    } catch (e) {
      r = { ok: false, reason: 'RUN_FAIL', text: '出错了。' };
    }

    // ③ 失败 → 退款
    if (!r?.ok) {
      try { await pts.refund(uid, price, `退款:抽奖`, String(ctx?.user?.name || '')); } catch { /* ignore */ }
      const back = (() => { try { return pts.balance(uid); } catch { return 0; } })();
      return await say(ctx, `${r?.text || '没做成。'}\n\n（**${price}** 分已退回，余额 **${back}**）`);
    }

    // ④ 成功（含发图的处理）
    const bal = (() => { try { return pts.balance(uid); } catch { return payRes.balance - price; } })();
    let out = String(r.text || '');
    out += `\n\n积分 **−${price}**　·　余额 **${bal}**`;

    // 抽奖可能中图 → 用 ctx.image 发（出站扩展的能力）
    if (r.imagePath) {
      try {
        if (typeof ctx.image === 'function') {
          await ctx.image({ localPath: r.imagePath });
        } else if (ctx.caps && typeof ctx.caps.image === 'function') {
          await ctx.caps.image({ localPath: r.imagePath });
        }
      } catch { /* 发图失败不影响文字 */ }
    }

    return await say(ctx, out);
  },
};
