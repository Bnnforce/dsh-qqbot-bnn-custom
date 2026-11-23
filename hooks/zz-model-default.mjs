/**
 * model-default — 统一模型 + 推理档位自动降档（2026-11-18 重写）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人要求（2026-11-02 原始 / 2026-11-18 重做）：
 *   「让他使用官方模型的时候自动把推理等级降到 Low；做一个 hook 自动改，
 *     下次可以直接从那里面改默认模型。」
 *
 * ── 机制依据（宿主行为）──────────────────────────────────────────────────────
 *   宿主每回合组装请求前读 `agent.options`：
 *     reasoningEffort = agent.options.reasoningEffort ?? 会话持久化值 ?? 适配器默认(high)
 *   所以只要在**请求组装之前**改写 `agent.options`，本回合就带上新档位，
 *   不需要重启、不需要改 profile。
 *   QQBot 插件自己的 `applyModelRoute()` 也改这个字段，但它只在「有 /bot-model 覆盖」时动手。
 *
 * ── 本次重写修复的真实 bug（2026-11-18 诊断）────────────────────────────────
 *   旧实现把「model 是否被用户钉过」和「effort 该不该改」绑在同一个 respect 标记上：
 *
 *     if (sid && overriddenSessionIds().has(sid)) respect = true;
 *     if (!respect && model不同)  { 改 model }
 *     if (want && effort不同)     { 改 effort }   ← 隐形地也受 respect 影响
 *
 *   后果：某个会话只要有 model override 记录（哪怕没写 effort），
 *        **effort 也永远不改**。实测 `07fef6c6` 会话全天 high。
 *
 *   新实现把两件事**彻底解耦**（见 lib/reasoning/decide.mjs）：
 *     · model：用户钉过 model → 不抢
 *     · effort：用户钉过 effort 才不抢（没钉就照常降档）
 *
 * ── 架构（工业化 / 为开源）──────────────────────────────────────────────────
 *   决策逻辑抽到 `lib/reasoning/`（纯函数、100% 可单测），
 *   本文件只做「扫 agent 列表 → 调决策 → 计时」。
 *
 * ── 配置（改这一个文件即可，下一回合生效）────────────────────────────────────
 *   {dataRoot}/.qqbot-extensions/data/model-default.json
 *   {
 *     "enabled": true,
 *     "provider": "deepseek-account",
 *     "model": "deepseek-flash",
 *     "reasoningEffort": "low",
 *     "effortProviders": ["deepseek-account", "deepseek-official"],
 *     "enforceModel": true,
 *     "respectModelOverride": true,     // 用户钉过 model → 不抢
 *     "respectEffortOverride": true,    // 用户钉过 effort → 不抢
 *     "scope": "qq"                     // qq | all
 *   }
 *
 *   ⚠️ 向后兼容：旧字段 `respectSessionOverride` 仍认（映射到上面两个）。
 *
 * ── 失败关闭 ────────────────────────────────────────────────────────────────
 *   任何异常只 warn，绝不影响消息链路。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeJsonAtomic } from '../lib/pure/atomic.mjs';
import { join } from 'node:path';
import { DATA_ROOT, EXT_DATA } from '../lib/pack-paths.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import {
  createReasoning,
  mergeReasoningConfig,
  resolveCwdPrefix,
} from '../lib/reasoning/index.mjs';

export const name = 'model-default';

// ★ 2026-11-18：路径改为**运行时解析**，支持测试注入 env.dataRoot
//   （原来用模块级常量 DATA_ROOT，测试无法隔离，会读生产配置）
function configFileOf(env) {
  const dr = String(env?.dataRoot || DATA_ROOT);
  return join(dr, '.qqbot-extensions', 'data', 'model-default.json');
}
function prefsFileOf(env) {
  const dr = String(env?.dataRoot || DATA_ROOT);
  return join(dr, '.qqbot', 'model-prefs.json');
}
/** 降级定时器节律（任务中心没接管时生效）。 */
const SWEEP_FALLBACK_MS = 5000;
/** prefs 缓存时长。 */
const PREFS_CACHE_MS = 3000;

/** 默认配置（首次运行自动写盘）。 */
const FIRST_RUN_CONFIG = {
  enabled: true,
  provider: '',
  model: '',
  reasoningEffort: 'low',
  effortProviders: [],
  enforceModel: true,
  respectModelOverride: true,
  respectEffortOverride: true,
  scope: 'qq',
};

/** 首次运行写一份空配置（方便主人手改）。 */
function ensureConfigFile(logger, env) {
  const CONFIG_FILE = configFileOf(env);
  try {
    if (existsSync(CONFIG_FILE)) return;
    mkdirSync(join(CONFIG_FILE, '..'), { recursive: true });
    writeJsonAtomic(CONFIG_FILE, FIRST_RUN_CONFIG);
    logger?.info?.('[model-default] 已生成默认配置文件');
  } catch { /* 写失败不影响运行（用内存默认值） */ }
}

/** 读配置（每回合现读，改完即生效；失败回落默认）。 */
function readConfig(logger, env) {
  const CONFIG_FILE = configFileOf(env);
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    const cfg = mergeReasoningConfig(raw);
    if (cfg.enabled !== false && !cfg.provider) {
      // 没配 provider → 不启用模型统一（只留档位逻辑，但档位也依赖 provider）
      logger?.debug?.('[model-default] 未配置 provider，本回合跳过');
    }
    return cfg;
  } catch {
    return mergeReasoningConfig(FIRST_RUN_CONFIG);
  }
}

/** prefs 缓存（会话级 override）。 */
let prefsCache = { at: 0, map: new Map() };

/**
 * 读会话级覆盖，返回 Map<sessionId, {provider?, model?, effort?}>。
 *
 * key 形如 `qqbot:<appId>:group:<gid>@<sessionId>`，取 `@` 之后那段。
 */
function readOverrides(env) {
  const PREFS_FILE = prefsFileOf(env);
  const now = Date.now();
  if (now - prefsCache.at < PREFS_CACHE_MS) return prefsCache.map;

  const map = new Map();
  try {
    const j = JSON.parse(readFileSync(PREFS_FILE, 'utf8'));
    for (const [key, val] of Object.entries(j?.overrides ?? {})) {
      const at = key.lastIndexOf('@');
      if (at < 0) continue;
      const sid = key.slice(at + 1);
      if (!sid) continue;
      map.set(sid, {
        provider: val?.provider,
        model: val?.model,
        effort: val?.effort,
      });
    }
  } catch { /* 没有偏好文件 = 没覆盖 */ }

  prefsCache = { at: now, map };
  return map;
}

/** 该 provider 列表里是否包含官方（诊断用）。 */
function describeCfg(cfg) {
  return `model=${cfg.enabled ? `${cfg.provider || '?'}/${cfg.model || '?'}` : 'disabled'}`
    + ` effort=${cfg.reasoningEffort}`
    + ` scope=${cfg.scope}`
    + ` respectModel=${cfg.respectModelOverride}`
    + ` respectEffort=${cfg.respectEffortOverride}`;
}

export async function run(env) {
  const ctx = env?.ctx;
  const logger = env?.logger;
  if (!ctx) return 'no-ctx';

  ensureConfigFile(logger, env);

  // ★ cwdPrefix：由 qqbotDataRoot 自动推导（开源部署无需改代码）
  // ★ 2026-11-18：cwdPrefix 的确定顺序
  //   ① 配置里显式写了 cwdPrefix → 用它（开源部署/测试隔离都走这条）
  //   ② 否则从 qqbotDataRoot 推导（生产默认）
  //   ⚠️ 不能用 env.dataRoot —— 测试注入时那是临时目录，推导出的前缀跟真实 agent 不匹配
  const cfgForPrefix = readConfig(logger, env);
  const cwdPrefix = String(cfgForPrefix.cwdPrefix || '').trim()
    || resolveCwdPrefix(DATA_ROOT);

  const stats = { set: 0, already: 0, skip: 0 };

  const sweep = () => {
    let list = [];
    try { list = ctx.get?.('agents')?.list?.() ?? []; } catch { return; }

    const cfg = readConfig(logger, env);
    const reasoning = createReasoning({ cfg, cwdPrefix, logger });
    const overrides = readOverrides(env);

    for (const agent of list) {
      try {
        const r = reasoning.apply(agent, overrides);
        if (r in stats) stats[r] += 1;
      } catch { /* 单个 agent 失败不影响其它 */ }
    }
  };

  // 首跑一次（不等第一个 tick）
  try { sweep(); } catch { /* ignore */ }

  // ★ 2026-11-18 重写时漏掉的**主力路径**：
  //   `agent/pre-step` 在**请求组装之前**触发（prepend 先于其它钩子），
  //   是本回合档位一定生效的保证。定时扫描只能覆盖"已存在但还没说话"的 agent。
  //   两者并存：pre-step 主力，sweep 兜底（旧版就是这个设计，重写时不该丢）。
  let offPreStep;
  try {
    offPreStep = ctx.on?.('agent/pre-step', async (payload, next) => {
      try {
        const agent = payload?.agent;
        if (agent) {
          const cfg = readConfig(logger, env);
          const reasoning = createReasoning({ cfg, cwdPrefix, logger });
          reasoning.apply(agent, readOverrides(env));
        }
      } catch { /* 绝不影响回合 */ }
      return next();
    }, { prepend: true });
  } catch (e) {
    try { logger?.warn?.(`[model-default] pre-step 订阅失败: ${e instanceof Error ? e.message : String(e)}`); } catch { /* ignore */ }
  }

  registerWithFallback('model-default', () => sweep(), {
    everyMs: SWEEP_FALLBACK_MS,
    logger,
  });

  try {
    env?.registerDispose?.(() => { /* registerWithFallback 自己登记清理 */ });
  } catch { /* ignore */ }

  return `ok(${describeCfg(readConfig(logger, env))})`;
}

/** 诊断（供 /model-default 或面板查看）。 */
export function diagnose(env) {
  const cfg = readConfig(undefined, env);
  const cwdPrefix = resolveCwdPrefix(String(env?.dataRoot || DATA_ROOT));
  return {
    configFile: configFileOf(env),
    cwdPrefix,
    cfg,
  };
}

export default { name, run, diagnose };