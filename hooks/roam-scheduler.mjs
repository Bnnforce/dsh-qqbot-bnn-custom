/**
 * roam-scheduler — 定时主动逛 B站（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 关键约束：hook 拿不到 agent
 *
 *   实测（2026-11-22，官方契约 extension-contract.md:40）：
 *     hooks/*.mjs 的 env 只有 caps/api/send/card/...，**没有 agent**
 *   而 tools.execute(input) 的实现是 selectExecutor(input.agent) —— 必须传 agent。
 *
 *   ⇒ 所以 hook **不能直接调 bili_watch**。
 *   ⇒ 正确做法：caps.wakeTo(prompt) 让她自己决定搜什么、看什么。
 *     这与 birthday-auto / r4-heartbeat-bridge / wake-lottery 完全同款。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { proactiveRoam, resolveConfig } from '../lib/roam/index.mjs';
import { diag } from '../lib/roam/store.mjs';

/**
 * 诊断（同步写，失败静默）。
 *
 * ⚠️ 2026-11-23 踩坑记录：
 *   ① 最初写成 `async function diagRoam` + 调用处不 await
 *      → 日志**偶尔缺失**（Promise 排着队，函数已返回）
 *   ② 改成同步时把定义删了、调用没删
 *      → 重启后**直接 ReferenceError**，整个 hook 崩
 *   现在：同步函数 + 静态 import 的 diag()，一次到位。
 */
function diagRoam(line) {
  try { diag(line); } catch { /* 诊断写不进去绝不影响主流程 */ }
}
import { registerWithFallback } from './zz-central-scheduler.mjs';

export const name = 'roam-scheduler';

/** 每小时 tick 一次（真正的触发由 shouldRoam 判定）。 */
const TICK_MS = 60 * 60 * 1000;

/** 已处理的群（避免同一群重复唤醒）。 */
const lastWokeAt = new Map();

/** 测试定时器（dispose 时清）。 */
const testTimers = [];

/**
 * 取群列表。
 *
 * ⚠️ 2026-11-23 真机踩坑：`caps.store.listGroups` / `caps.listGroups` **都不存在**
 *   （查过 ext-capabilities.js，没有这个能力）⇒ 群列表永远为空 ⇒ 主动逛从未触发。
 *
 * 正解：跟 R5.6 唤醒抽奖同款 —— 从**心跳状态目录**读
 * （每个在群里说过话的群都会有一份心跳状态，等价于「活跃群列表」）。
 *
 * @returns {string[]}
 */
function listGroups() {
  try {
    const override = String(process.env.PERSONA_DATA_ROOT ?? '').trim();
    const home = process.env.DSH_HOME
      || join(process.env.HOME || '{DSH_HOME}/files/home', '.dsh');
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
 * tick 一次：对每个群判断是否该主动逛。
 *
 * @param {object} env
 */
async function tick(env) {
  const caps = env?.caps || env;
  const cfg = resolveConfig();
  if (!cfg.enabled) return;

  // ⚠️ 2026-11-23 真机踩坑：原来一次 tick 会把**所有群**都唤醒
  //   （实测 00:54 一次触发 5 个群，全部同时开始搜 B站 → 疯狂请求 + 群里刷屏）
  //   ⇒ 一次 tick **最多唤醒 1 个群**，且全局两次唤醒间隔 ≥ 30 分钟。
  const GLOBAL_GAP_MS = 30 * 60 * 1000;
  if (lastWokeAt.get('__global__') && Date.now() - lastWokeAt.get('__global__') < GLOBAL_GAP_MS) {
    return;
  }

  // 打乱顺序，避免永远只宠幸第一个群
  const groups = listGroups();
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }

  for (const gid of groups) {
    try {
      // 同一群 1 小时内只唤醒一次（proactiveRoam 内部还有日上限）
      const last = lastWokeAt.get(gid) || 0;
      if (Date.now() - last < 60 * 60 * 1000) continue;

      // ★★ 2026-11-23 修：全局发言预算必须**在 proactiveRoam 之前**检查。
      //
      //   原顺序是「先 proactiveRoam（内部 bumpProactive 已把当日计数 +1）→ 再 trySpeak」，
      //   于是被预算拦下时，**日计数已经被吃掉了**。实测后果（19:11:49 那次 tick）：
      //     7 个群同时 roamed=true 并各自 dailyProactive +1，
      //     然后 7 个群全部「全局预算不足，本轮让路」
      //   ⇒ 一次 tick 空烧掉 7 个群的当日额度，却一条消息都没发出去。
      //
      //   现在：先申请预算，拿到了才真去逛。没拿到就 continue，**不碰任何计数**。
      const { trySpeak } = await import('../lib/roam/speak-budget.mjs');
      if (!trySpeak(gid, 'roam', cfg)) continue;

      const r = await proactiveRoam({ gid, cfg });
      if (!r.roamed) continue;


      // ⚠️ 2026-11-23 真机踩坑 + 根因定位：
      //   wakeTo 走 session-registry.findManagerByPeer → manager.injectToPeer。
      //   **会话闲置一段时间会被回收**（实测 105 分钟没动静就回收了）。
      //   插件内部虽有 getOrCreateByPeerWeb 重建，但它只在 if (!m) 分支里 ——
      //   而 findManagerByPeer 按「群注册表归属」仍能返回 manager（进程活着），
      //   ⇒ 重建逻辑**永远进不去** ⇒ injectToPeer 查不到 record ⇒ 返回 false。
      //   这是插件层的逻辑缺陷，我们改不了 node_modules。
      //   （配置层已用 `sessionIdleTimeout: 4h` 覆盖 3h 间隔，见 profile cordis.patch.yml）
      //
      //   ★ 2026-11-23：原来的「caps.api 兜底直发」已删除，理由见下方注释。
      let ok = false;
      let ret = null;
      try {
        ret = await caps.wakeTo?.('group', gid, r.prompt);
        ok = ret !== false;
        diagRoam('[主动逛] ' + gid.slice(0, 12) + ' wakeTo=' + String(ret) + ' ok=' + ok);
      } catch (e) {
        diagRoam('[主动逛] ' + gid.slice(0, 12) + ' wakeTo 抛错: ' + String(e?.message || e));
      }

      // ★ 2026-11-23 修：删掉「兜底直发一句话」这套。
      //
      //   原实现：wakeTo 失败 → caps.api 直发「（她本来想刷会儿 B站，但会话掉线了）」。
      //   两个致命问题（都有实测证据，别再改回去）：
      //
      //   ① **发不出去**。`caps.api` 是裸 fetch，不带 msg_id ⇒ 走主动消息通道，
      //      而主动消息有频次/权限限制。实测 `.qqbot/ext-deliver.log`：
      //        bili_watch card ok=false err=API Error [.../messages]: 主动消息失败, 无权限
      //      三个群连发全灭 —— 这条兜底从来没成功过，只是在刷日志。
      //
      //   ② **语义错了**。「她本来想刷会儿 B站，但会话掉线了」是**系统报错文案**，
      //      却顶着她的身份发到群里。群友看到的是"爱莉希雅说了一句莫名其妙的话"。
      //      宁可不说，也不要替她说这种话。
      //
      //   正确行为：**失败就静默**（记诊断日志即可）。会话被回收本来就是常态
      //   （`sessionIdleTimeout` 已调 4h 覆盖 3h 间隔，仍可能有边界情况），
      //   下一轮 tick 自然会重试，不需要惊动群友。
      if (!ok) {
        diagRoam('[主动逛] ' + gid.slice(0, 12) + ' wakeTo 失败 → 本轮静默（不发兜底文案）');
      }
      if (ok) {
        lastWokeAt.set(gid, Date.now());
        lastWokeAt.set('__global__', Date.now());
        // ★ 一次 tick 只叫一个群，立即跳出
        break;
      }
    } catch { /* 全部吞掉，不阻塞主链 */ }
  }
}

/**
 * hook 入口。
 *
 * @param {object} env
 */
export async function run(env) {
  const logger = env?.logger ?? console;
  const cfg = resolveConfig();

  if (!cfg.enabled) {
    logger?.info?.('[roam-scheduler] 已禁用（配置 enabled:false）');
    return;
  }

  // ★ 2026-11-23 恢复发言预算计数（重启后不重置当日额度）
  try {
    const { loadBudget } = await import('../lib/roam/speak-budget.mjs');
    loadBudget();
  } catch { /* ignore */ }

  logger?.info?.('[roam-scheduler] 启动：每小时检查一次是否该主动逛');

  // ★ 临时测试通道：每 60 秒看一次 config.testNow，为 true 就立即触发一次，
  //   然后把 testNow 写回 false（只触发一次，不会刷屏）。
  const testTimer = setInterval(async () => {
    try {
      const c = resolveConfig();
      if (c.testNow !== true) return;

      let wroteBack = false;
      // 先写回 false，防止重复触发
      // ⚠️ 2026-11-23 真机踩坑：原来手拼路径依赖 QQBOT_DATA_ROOT，
      //   而生产环境**没有这个环境变量** ⇒ 写到错误位置 ⇒ testNow 永远是 true。
      //   正解：用 config.mjs 的 configFile()（它内部走 dataRoot() 兜底）。
      try {
        const fs = await import('node:fs');
        const { configFile } = await import('../lib/roam/config.mjs');
        const file = configFile();
        if (fs.existsSync(file)) {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
          raw.testNow = false;
          fs.writeFileSync(file, JSON.stringify(raw, null, 2) + String.fromCharCode(10));
        } else {
          wroteBack = true;   // 文件都不存在了，等于不用再触发
        }
        wroteBack = true;
      } catch (e) {
        try { diagRoam('[测试] testNow 写回失败: ' + String(e?.message || e)); } catch { /* ignore */ }
      }

      // ⚠️ 2026-11-23 加固：写回失败就**不触发** —— 否则每 60 秒都跑一次
      if (!wroteBack) {
        try { diagRoam('[测试] 写回失败，本轮跳过（防无限触发）'); } catch { /* ignore */ }
        return;
      }

      logger?.info?.('[roam-scheduler] testNow=true → 立即触发一次');
      await tick(env);
    } catch { /* ignore */ }
  }, 60 * 1000);
  if (typeof testTimer.unref === 'function') testTimer.unref();
  testTimers.push(testTimer);

  registerWithFallback('roam-scheduler', () => tick(env), {
    env,
    fallbackMs: TICK_MS,
    label: 'roam-scheduler',
    meta: { id: 'ext-roam-scheduler' },
  });
}

export function dispose() {
  lastWokeAt.clear();
  for (const t of testTimers) {
    try { clearInterval(t); } catch { /* ignore */ }
  }
  testTimers.length = 0;
}

export default { name, run, dispose };
