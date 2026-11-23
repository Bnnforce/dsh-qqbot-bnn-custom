/**
 * reasoning/index — 推理档位门面（2026-11-18）
 *
 * 接入层（hook）只调这里，不直接碰 config/decide/apply。
 */

export {
  DEFAULT_REASONING_CONFIG,
  mergeReasoningConfig,
  validateReasoningConfig,
  effortFor,
  resolveCwdPrefix,
} from './config.mjs';

export { decide, isQqAgent, SKIP } from './decide.mjs';
export { applyToAgent, writeOptions } from './apply.mjs';

import { mergeReasoningConfig, validateReasoningConfig, resolveCwdPrefix } from './config.mjs';
import { applyToAgent } from './apply.mjs';

/**
 * 创建 reasoning 运行时实例。
 *
 * @param {{cfg?:object, cwdPrefix?:string, hasQqChannel?:Function, logger?:object}} opts
 */
export function createReasoning(opts = {}) {
  const cfg = mergeReasoningConfig(opts.cfg);
  const errs = validateReasoningConfig(cfg);
  const cwdPrefix = String(opts.cwdPrefix ?? '').trim() || resolveCwdPrefix(opts.cwdPrefix === undefined ? '' : '');

  return {
    cfg,
    cfgErrors: errs,
    cwdPrefix,

    /**
     * 应用到单个 agent。
     * @param {object} agent
     * @param {Map<string,{effort?:string}>} [overrides]
     * @returns {'set'|'already'|'skip'}
     */
    apply(agent, overrides) {
      return applyToAgent(
        agent,
        { cfg, cwdPrefix, overrides, hasQqChannel: opts.hasQqChannel },
        opts.logger,
      );
    },

    /** 诊断快照。 */
    diagnose() {
      return {
        enabled: cfg.enabled,
        provider: cfg.provider,
        model: cfg.model,
        effort: cfg.reasoningEffort,
        effortProviders: cfg.effortProviders,
        respectModel: cfg.respectModelOverride,
        respectEffort: cfg.respectEffortOverride,
        scope: cfg.scope,
        cwdPrefix,
        cfgErrors: errs,
      };
    },
  };
}