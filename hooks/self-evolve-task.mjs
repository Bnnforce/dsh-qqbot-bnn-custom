/**
 * self-evolve-task — 自我进化 C 档触发器（R8 S8 收尾，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * C 档 = 有限自改。这个 hook 是**触发器**，真正的自改逻辑在插件侧
 * `evolution-auto.js`（纯函数 + 七道兜底）。
 *
 * ── 数据流 ─────────────────────────────────────────────────────────────────
 *
 *   本 hook（扩展包侧）               插件侧（dsh-bnnbotbox）
 *   ├─ 读 metrics.jsonl（自己的数据）   ├─ evolution-auto.js（能力）
 *   ├─ 读 behavior-state.json（插件写） ├─ 白名单/黑名单/护栏/夹紧
 *   └─ 调 evolveOnce() 落地自改 ────────→ 写 behavior-state.json + 备份 + 审计
 *
 * ── 安全铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① 默认急停：config.selfEvolve 默认 false，主人显式开启才跑
 *   ② 每周最多一次（与 evolution-task 同频，错峰）
 *   ③ 插件缺席/报错 → 静默跳过，绝不影响主链
 *   ④ 自改后**通知主人**（私聊/日志），让主人知道她改了什么、可一键回滚
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { readJsonSafe } from '../lib/pure/atomic.mjs';

const name = 'self-evolve-task';

/** 每周一次（与 evolution-task 错开：周三低峰）。 */
const FALLBACK_MS = 7 * 24 * 3600_000;

/** 持久化配置文件（与 birthday-config.json 同一模式）。 */
const CONFIG_NAME = 'self-evolve-config.json';

/** metrics 快照文件（本扩展自己写）。 */
const METRICS_FILE = join(EXT_DATA, 'persona-evolution', 'metrics.jsonl');

/** ★ R9：自我文件（给 Feedback 审查用）。 */
const DSH_HOME_X = process.env.DSH_HOME
  || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';
const SELF_DIR_X = join(DSH_HOME_X, '..', '..', '..', '..', 'sdcard', 'DSH', 'Bot', '自我');
const FACTS_FILE = join(SELF_DIR_X, '我知道的.md');
const REFLECT_FILE = join(SELF_DIR_X, '我的反思.md');

/** 读一个自我文件（读不到返回空串）。 */
function readSelfFile(f) {
  try {
    return existsSync(f) ? String(readFileSync(f, 'utf8') ?? '').slice(0, 4000) : '';
  } catch { return ''; }
}

/** 配置文件路径。 */
const CONFIG_FILE = join(EXT_DATA, CONFIG_NAME);

/** DSH_HOME（插件数据根，用于定位插件代码与 state 目录）。 */
const DSH_HOME = process.env.DSH_HOME
  || join(process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home', '.dsh');

/** 插件 state 目录。 */
const PLUGIN_STATE_DIR = join(DSH_HOME, 'data', 'dsh-anti-ai-persona', 'state');

/** 插件 evolution-auto.js 绝对路径（动态 import，缺席则跳过）。 */
const PLUGIN_DIR = join(DSH_HOME, 'plugins', 'dsh-bnnbotbox');
const PLUGIN_AUTO_JS = join(DSH_HOME, 'plugins', 'dsh-bnnbotbox', 'lib', 'persona', 'r4', 'evolution-auto.js');

function diag(event, data = {}) {
  try {
    const file = join(EXT_DATA, 'self-evolve.log');
    appendLogRotating(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 读 metrics 历史快照。 */
function readMetrics() {
  if (!existsSync(METRICS_FILE)) return [];
  try {
    const raw = readFileSync(METRICS_FILE, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch { return []; }
}

/**
 * 读配置里的 selfEvolve 开关。
 *
 * 默认**关闭**（急停优先）：只有主人显式配置 true 才启用 C 档。
 * 读取优先级：配置文件 self-evolve-config.json → 环境变量。
 */
function resolveSelfEvolveConfig(env) {
  try {
    // ① 持久化配置文件（首选，重启不丢）
    const cfg = readJsonSafe(CONFIG_FILE) ?? {};
    if (cfg?.selfEvolve === true) return true;
    // ② env.config
    if (env?.config?.selfEvolve === true) return true;
    // ③ 环境变量（临时覆盖）
    if (process.env.QQBOT_SELF_EVOLVE === 'true' || process.env.QQBOT_SELF_EVOLVE === '1') return true;
    return false;
  } catch { return false; }
}

export async function run(env) {
  const tick = async () => {
    try {
      // ① 急停：默认关闭，主人没开就不跑
      const enabled = resolveSelfEvolveConfig(env);
      if (!enabled) {
        diag('skip', { reason: 'selfEvolve 未开启（急停默认）' });
        return;
      }

      // ② 读 metrics 快照
      const snapshots = readMetrics();
      if (snapshots.length < 3) {
        diag('skip', { reason: '快照不足', count: snapshots.length });
        return;
      }

      // ③ 插件缺席 → 跳过
      if (!existsSync(PLUGIN_AUTO_JS)) {
        diag('skip', { reason: '插件 evolution-auto.js 不存在' });
        return;
      }

      // ④ 动态 import 插件侧 C 档能力（try/catch，缺席/报错静默）
      //    ⚠️ 不用 import(x+'?'+Date.now()) 缓存破坏（会内存泄漏，项目规范禁止）。
      //    正常 import 即可，Node 会缓存模块实例。
      let AUTO;
      try {
        AUTO = await import(`file://${PLUGIN_AUTO_JS}`);
      } catch (e) {
        diag('skip', { reason: 'import 失败', err: e instanceof Error ? e.message : String(e) });
        return;
      }

      // ⑤ ★ R9：加载 Feedback（独立审查者）
      //    逻辑在插件侧 evolution-feedback.js，
      //    按**依赖注入**传给 evolveOnce（插件侧不直接 import，保住静态断言）。
      let reviewProposal = null;
      try {
        const FB = await import(`file://${PLUGIN_DIR}/lib/persona/r4/evolution-feedback.js`);
        if (typeof FB.reviewProposal === 'function') {
          const facts = readSelfFile(FACTS_FILE);
          const reflections = readSelfFile(REFLECT_FILE);
          reviewProposal = (proposal) => FB.reviewProposal(proposal, { facts, reflections });
          diag('feedback-loaded', { factsChars: facts.length, reflChars: reflections.length });
        }
      } catch (e) {
        diag('feedback-missing', { err: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100) });
      }

      // ⑥ 调 evolveOnce 落地自改（带 Feedback）
      const result = await AUTO.evolveOnce({
        stateDir: PLUGIN_STATE_DIR,
        config: { selfEvolve: true },
        snapshots,
        now: Date.now(),
        ...(reviewProposal ? { reviewProposal } : {}),
      });

      if (!result.ok) {
        diag('no-change', { reason: result.reason });
        return;
      }

      // ⑥ 自改成功 → 记日志（含「主人可见」审计）
      diag('evolved', {
        applied: result.applied,
        backupPath: result.backupPath,
        hint: '可回滚：node 插件侧 rollback 或恢复备份文件',
      });
    } catch (e) {
      diag('failed', { err: e instanceof Error ? e.message : String(e) });
    }
  };

  // 首轮立即检查一次（如果已到周期）
  await tick();

  registerWithFallback('self-evolve-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'self-evolve-task', meta: { id: 'ext-self-evolve' },
  });
}

export default { name, run };
