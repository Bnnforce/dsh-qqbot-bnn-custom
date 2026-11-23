/**
 * reasoning/decide — 纯函数决策（2026-11-18）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独抽这个模块：
 *
 *   ★ 修复的真实 bug（2026-11-18 诊断）
 *
 *   旧实现把「model 是否被用户钉过」和「effort 该不该改」**绑在同一个 respect 标记**上：
 *
 *     if (sid && overriddenSessionIds().has(sid)) respect = true;
 *     if (!respect && model不同) { 改 model }
 *     if (want && effort不同)    { 改 effort }   ← 但也受 respect 影响（隐形）
 *
 *   后果：某个会话只要有 model override 记录（哪怕没写 effort），
 *        **effort 也永远不改**。实测 `07fef6c6` 会话全天都是 high。
 *
 *   本模块把两件事**彻底解耦**：
 *     · model：用户钉过 → 不抢
 *     · effort：用户钉过 effort 才不抢（没钉就照常降档）
 *
 * ── 设计原则 ────────────────────────────────────────────────────────────────
 *   · **纯函数**：不读文件、不写状态、不看时间 → 100% 可测
 *   · **不抛异常**：非法输入返回 safe 的 skip 结果
 *   · **幂等**：值已正确时 changed=false
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { effortFor } from './config.mjs';

/** skip 的原因码（可观测，供日志/诊断用）。 */
export const SKIP = {
  DISABLED: 'disabled',
  NOT_QQ: 'not-qq',
  NO_OPTIONS: 'no-options',
  /** 用户钉过 model 且这次只差 model（effort 已正确）。 */
  MODEL_PINNED: 'model-pinned',
};

/**
 * @typedef {object} DecideInput
 * @property {object}  agent      宿主 agent（只读 options / session）
 * @property {object}  cfg        已合并的配置
 * @property {Map<string,{effort?:string}>} [overrides] 会话级覆盖（从 model-prefs 解析）
 * @property {string}  [cwdPrefix] 已解析的 QQ cwd 前缀
 * @property {(agent:object)=>boolean} [hasQqChannel] 判定"是不是 QQ 会话"（可注入便于测试）
 */

/**
 * @typedef {object} DecideResult
 * @property {boolean} changed    是否需要写回
 * @property {string} [skip]      不改的原因（changed=false 时）
 * @property {string} [provider]  目标 provider
 * @property {string} [model]     目标 model
 * @property {string} [effort]    目标 effort
 * @property {string} [reason]    人类可读的变更说明
 */

/**
 * 判断 agent 是不是 QQ 会话。
 *
 * @param {object} agent
 * @param {object} cfg
 * @param {string} cwdPrefix
 * @param {(a:object)=>boolean} [hasQqChannel]
 * @returns {boolean}
 */
export function isQqAgent(agent, cfg, cwdPrefix, hasQqChannel) {
  if (String(cfg?.scope ?? 'qq') === 'all') return true;

  let cwd = '';
  try {
    cwd = String(agent?.session?.header?.cwd ?? agent?.session?.cwd ?? '');
  } catch { return false; }

  // 没配 cwdPrefix → 退化为"只看 channel"（开源部署时由调用方注入）
  if (cwdPrefix && !cwd.startsWith(cwdPrefix)) return false;

  // 优先用注入的判定（测试可控）
  if (typeof hasQqChannel === 'function') {
    try { return hasQqChannel(agent) === true; } catch { return false; }
  }
  // 生产路径：看 ctx 上有没有 qqChannel 服务
  try {
    return Boolean(agent?.ctx?.get?.('qqChannel'));
  } catch {
    return false;
  }
}

/**
 * 取会话 id。
 * @param {object} agent
 * @returns {string}
 */
function sessionIdOf(agent) {
  try { return String(agent?.session?.id ?? ''); } catch { return ''; }
}

/**
 * **核心决策函数**（纯函数）。
 *
 * @param {DecideInput} input
 * @returns {DecideResult}
 */
export function decide(input) {
  const { agent, cfg } = input || {};
  const cwdPrefix = String(input?.cwdPrefix ?? '');
  const overrides = input?.overrides instanceof Map ? input.overrides : new Map();

  // ── 前置：开关 / 作用域 / options ──
  if (!cfg || cfg.enabled === false) return { changed: false, skip: SKIP.DISABLED };

  const opts = agent?.options;
  if (!opts || typeof opts !== 'object') return { changed: false, skip: SKIP.NO_OPTIONS };

  if (!isQqAgent(agent, cfg, cwdPrefix, input?.hasQqChannel)) {
    return { changed: false, skip: SKIP.NOT_QQ };
  }

  // ── 会话级覆盖（两个维度分开取）──
  const sid = sessionIdOf(agent);
  const ov = sid ? overrides.get(sid) : undefined;
  const pinnedModel = ov?.model !== undefined && ov?.model !== '';
  const pinnedEffort = ov?.effort !== undefined && ov?.effort !== '';

  // ── 目标值初始化（默认沿用现值）──
  let provider = String(opts.provider ?? '');
  let model = String(opts.model ?? '');
  let effort = String(opts.reasoningEffort ?? '');
  const notes = [];

  // ── ① 模型：只在"用户没钉过 model"时改 ──
  const cfgProvider = String(cfg.provider ?? '').trim();
  const cfgModel = String(cfg.model ?? '').trim();
  const wantModelChange = cfg.enforceModel !== false && cfgProvider && cfgModel;

  const respectModel = cfg.respectModelOverride !== false && pinnedModel;
  if (wantModelChange) {
    if (respectModel) {
      notes.push('model:用户已钉(不改)');
    } else if (provider !== cfgProvider || model !== cfgModel) {
      provider = cfgProvider;
      model = cfgModel;
      notes.push(`model:${opts.provider ?? '?'}/${opts.model ?? '?'}→${cfgProvider}/${cfgModel}`);
    }
  }

  // ── ② 档位：**独立判定**，只受 effort 覆盖影响 ──
  //    ★ 这是修 bug 的关键：pinnedModel 不影响努力档位
  const respectEffort = cfg.respectEffortOverride !== false && pinnedEffort;
  if (respectEffort) {
    notes.push('effort:用户已钉(不改)');
  } else {
    // ★ 2026-11-18（T2 修）：档位判定用「最终生效的 provider」。
    //
    //   两种情况：
    //     ① model 没被钉 → provider 已经改成 cfgProvider → 用 provider ✅
    //     ② model 被钉住 → provider 还是原值，但用户钉的是**官方模型**，
    //        档位仍应按 cfg.provider 判（这才是"我们想降档的目标 provider"）
    //
    //   所以：优先 provider（已改的情况），降级用 cfgProvider（钉住的情况）。
    //   ⚠️ 不能用 opts.provider —— 那正是要被替换掉的旧值。
    //
    // ★ T2 修正（2026-11-18）：provider 的初值**非空**（是现值 'x'），
    //   所以 `provider || cfgProvider` 永远取到旧值，永远判不在列表里。
    //   正确做法：**看 provider 有没有真的被改**：
    //     改过 → 用新值（已经是 cfgProvider）
    //     没改（被钉）→ 用 cfgProvider（我们要降档的目标）
    // ★ 2026-11-18：档位判定用「**实际会生效的 provider**」
    //
    //   三种情况：
    //     ① 配了 enforceModel 且没被钉 → provider 已改成 cfgProvider → 用它
    //     ② 配了 enforceModel 但被钉 → 仍按 cfgProvider 判（我们想降档的目标）
    //     ③ **没配 enforceModel（只管档位）** → 用**现值**（不假设会换成 cfgProvider）
    //
    //   ★ ③ 是关键：enforceModel:false 时 provider 不会被改，
    //     所以档位必须按"现在真正在用的 provider"判，否则 trae 会被误降档。
    const providerChanged = provider !== String(opts.provider ?? '');
    let effProvider;
    if (!wantModelChange) {
      // 不统一模型 → 用现值
      effProvider = String(opts.provider ?? '');
    } else if (providerChanged) {
      // 已改成目标 → 用新值
      effProvider = provider;
    } else {
      // 被钉住没改 → 用 cfgProvider（降档目标）
      effProvider = cfgProvider || provider || String(opts.provider ?? '');
    }
    const want = effortFor(effProvider, cfg);
    if (want && String(opts.reasoningEffort ?? '') !== want) {
      effort = want;
      notes.push(`effort:${opts.reasoningEffort ?? '-'}→${want}`);
    }
  }

  // ── ③ 是否需要写回 ──
  const changedProvider = provider !== String(opts.provider ?? '');
  const changedModel = model !== String(opts.model ?? '');
  const changedEffort = effort !== String(opts.reasoningEffort ?? '');
  const changed = changedProvider || changedModel || changedEffort;

  if (!changed) {
    // 区分"本来就对"和"被钉住所以没改"
    if (pinnedModel && wantModelChange && provider !== cfgProvider) {
      return { changed: false, skip: SKIP.MODEL_PINNED };
    }
    return { changed: false };
  }

  return {
    changed: true,
    provider,
    model,
    effort,
    reason: notes.join('; '),
  };
}