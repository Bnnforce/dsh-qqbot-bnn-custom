/**
 * wake-lottery — 唤醒抽奖触发层（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它做什么
 *   每 10 分钟（由中央调度器驱动）检查每个群是否满足「刚睡醒」，
 *   满足则按 A/B 模式分流：
 *
 *     A 自抽（self）  → caps.wakeTo('group', gid, prompt)
 *                       她自己抽（非属主奖项），带着奖品描述说一句话
 *     B 邀请（invite）→ caps.api 直发带按钮的内联键盘卡片，让群友点
 *
 * 它不做什么
 *   · 不做判定逻辑（全在 lib/wake-lottery/core.mjs，纯函数）
 *   · 不阻塞主链（任何异常都吞掉 + 落 diag）
 *
 * ═══ 2026-11-22 三次真机修复记录 ═══
 *
 *   ① A 模式初版用 executeDraw({ openid: 'bot-self' })
 *      → 积分系统里创建假用户、图鉴被污染
 *      → 改为 selfDraw()：只走非属主出口，不发分、不记图鉴
 *
 *   ② B 模式初版用 caps.wakeTo() 让 AI "发一张卡片"
 *      → 完全错误：wakeTo 只会让 AI 说一句话，没有发卡能力
 *      → 真机表现：群里两行纯文本「手边有个盒子 / 点一下按钮」，**没有按钮**
 *      → 改为 caps.api 直发 msg_type=2 + keyboard（三级降级）
 *
 *   ③ 卡片必须三处齐备：卡片文件 + botplay-events.json 登记 + 触发命令
 *      → 后两处漏过，check-card-commands.mjs 会报
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { DATA_ROOT } from '../lib/pack-paths.mjs';
import { diag } from '../lib/wake-lottery/store.mjs';

export const name = 'wake-lottery';

/** 降级定时器周期（调度器不可用时的兜底）。 */
const FALLBACK_MS = 10 * 60 * 1000;

/**
 * A 模式（她自抽）允许的出口白名单 —— **不含 points**。
 *
 * 自抽的价值在「她自己说一句」，不在"给谁发奖"。
 * 所以：不发积分（积分必须有真实属主）、不写图鉴（图鉴是用户收集）。
 */
const SELF_DRAW_POOL = ['quote', 'secret', 'image', 'song', 'sticker'];

/** 懒加载核心模块（支持热重载）。 */
async function core() {
  return import('../lib/wake-lottery/index.mjs?wl=' + Date.now());
}

/** 取数据根。 */
function dataRootOf(env) {
  return env?.dataRoot || env?.caps?.dataRoot || DATA_ROOT;
}

/**
 * 列出所有有心跳记录的群（= 有活性的群）。
 * 只看文件名，不读内容（快）。
 */
function listGroups() {
  try {
    const override = String(process.env.PERSONA_DATA_ROOT ?? '').trim();
    const home = process.env.DSH_HOME || join(process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home', '.dsh');
    const dir = join(override || join(home, 'data', 'dsh-anti-ai-persona'), 'state', 'heartbeat');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''))
      .filter((n) => /^[A-Za-z0-9_-]+$/.test(n));
  } catch {
    return [];
  }
}

/**
 * A 模式自抽：只在非属主出口里选一个，**不碰积分/图鉴**。
 */
async function selfDraw(cfg, nowMs) {
  const registry = await import('../lib/wake-lottery/prizes/registry.mjs?wl=' + Date.now());
  const coreMod = await import('../lib/wake-lottery/core.mjs?wl=' + Date.now());

  const pool = await registry.availableOutlets({ cfg });
  const usable = SELF_DRAW_POOL.filter((k) => pool.includes(k));
  const finalPool = usable.length > 0 ? usable : ['quote'];

  const weights = coreMod.restrictToAvailable(cfg.baseWeights || {}, finalPool, cfg.minWeight);
  const pickKey = coreMod.weightedPick(weights);

  // 权重只留选中的那一个，确保 registry 抽到的就是它
  const only = {};
  for (const k of Object.keys(cfg.baseWeights || { quote: 1 })) only[k] = 0;
  only[pickKey] = 100;

  return registry.draw({
    gid: '__self__',
    openid: '',              // 空 → points 出口会拒绝，天然排除
    cfg,
    weights: only,
    timeoutMs: cfg.prizeTimeoutMs,
    nowMs,
  });
}

/**
 * 发邀请卡片（B 模式）。
 *
 * ═══ 2026-11-22 三条死路 + 最终解 ═══
 *
 * ① `caps.wakeTo(gid, prompt)` 让 AI "发一张卡片"
 *    → **错**：wakeTo 只会让 AI 说一句话，没有发卡能力
 *    → 真机：群里两行纯文本「手边有个盒子 / 点一下按钮」，**没按钮**（主人截图）
 *
 * ② hook 里直接 `caps.markdownCard(text, keyboard)`
 *    → 卡片发出去了，但**点了没反应**
 *    → 根因：官方点击派发链只认 `tools` 和 `commands` 的 onInteraction
 *      （dist/features/ext-tool-interaction.js:88,93），**hooks 不在链里**
 *
 * ③ ✅ 最终解：wakeTo 让 AI 调 `tools/wake_lottery_card.mjs` 发卡
 *    → tools 有 onInteraction，点击能回到我们的回调
 *    → 这条链与 commands/点歌.mjs 触发 botplay 是同一个思路
 *
 * @returns {Promise<boolean>} 是否成功唤起（卡片由工具发，这里只能确认唤醒成功）
 */
async function sendInvite(env, gid, cycleId) {
  const caps = env?.caps ?? env ?? {};

  const prompt = [
    '（系统提示，不是主人说的话）你刚醒过来，手边摸到一个盒子。',
    '请调用工具 wake_lottery_card 把它发到群里 —— 那是一张带按钮的卡片，群友能点。',
    '调用后不要再额外说别的话，卡片本身就够说明问题了。',
    '如果工具报错，就什么也别说。',
  ].join('\n');

  try {
    const ok = (await caps.wakeTo?.('group', gid, prompt)) !== false;
    diag(`[B模式] gid=${gid} cycle=${cycleId} wakeTo=${ok ? 'ok' : 'fail'}（余下由工具发卡）`);
    return ok;
  } catch (e) {
    diag(`[B模式] wakeTo 抛错: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 主 tick：对每个群检查一次。 */
async function tick(env) {
  const C = await core();
  const cfg = C.loadRuntimeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };

  const groups = listGroups();
  if (groups.length === 0) return { ok: false, reason: 'no-groups' };

  let started = 0;
  let woke = 0;
  const results = [];

  for (const gid of groups) {
    try {
      // ★ 2026-11-23 全局发言预算：和 R5.7/life-stream 共用额度，防止一天主动说话太多次
      //   （实测 TEST 群一天机器人 22 条 / 群友 19 条，她比人说得还多）
      let budgetOk = true;
      try {
        const { trySpeak } = await import('../lib/roam/speak-budget.mjs');
        budgetOk = trySpeak(gid, 'lottery');
      } catch { /* 预算模块挂了就放行，不能因它让抽奖停摆 */ }
      if (!budgetOk) {
        results.push({ gid, status: 'skip', reason: 'speak-budget' });
        continue;
      }

      const r = await C.checkAndStart({ gid, cfg });
      if (!r.started) {
        results.push({ gid, status: 'skip', reason: r.reason });
        continue;
      }
      started += 1;

      if (r.mode === 'self') {
        // A 模式：她自己抽一个，说出来（不发分、不记图鉴）
        const draw = await selfDraw(cfg, Date.now());
        if (!draw.ok) { results.push({ gid, status: 'self-draw-failed', reason: draw.reason }); continue; }

        const prompt = C.buildNarration({
          prizeKey: draw.prizeKey,
          payload: draw.payload,
          hhmm: r.hhmm,
          quietMinutes: r.quietMinutes,
        }, cfg);

        const caps = env?.caps ?? env ?? {};
        let ok = false;
        try { ok = (await caps.wakeTo?.('group', gid, prompt)) !== false; } catch { ok = false; }
        if (ok) woke += 1;
        results.push({ gid, status: ok ? 'self-sent' : 'wake-failed', prize: draw.prizeKey });
      } else {
        // B 模式：发带按钮的卡片
        const ok = await sendInvite(env, gid, r.cycleId);
        if (ok) woke += 1;
        results.push({ gid, status: ok ? 'invite-sent' : 'invite-failed' });
      }
    } catch (e) {
      results.push({ gid, status: 'error', reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { ok: started > 0, started, woke, scanned: groups.length, results };
}

export async function run(env) {
  // ★ 2026-11-23 恢复发言预算计数
  try {
    const { loadBudget } = await import('../lib/roam/speak-budget.mjs');
    loadBudget();
  } catch { /* ignore */ }

  const safeTick = async () => {
    try { await tick(env); } catch (e) {
      diag(`[hook] tick 异常: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 启动不立即跑：心跳状态要等插件起来才准，交给调度器第一次 tick
  registerWithFallback('wake-lottery', () => safeTick(), {
    env,
    fallbackMs: FALLBACK_MS,
    label: 'wake-lottery',
    meta: { id: 'ext-wake-lottery' },
  });
}

export function dispose() {
  // 调度器统一清理；此处保留导出以满足契约
}

export default { name, run, dispose };
