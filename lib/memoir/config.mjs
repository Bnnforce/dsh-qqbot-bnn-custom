/**
 * memoir/config — 回忆录配置默认值（R5.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 配置读取策略（按开发规范 §3.1「不污染环境」）
 *
 *   ① 优先读环境变量（测试隔离用）
 *   ② 其次读 `{EXT_DATA}/memoir-config.json`（用户可改）
 *   ③ 都拿不到 → DEFAULT_CONFIG
 *
 * 所有字段都有默认值，**坏配置不抛**（返回默认）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { EXT_DATA } from '../pack-paths.mjs';
import { readJsonSafe } from '../pure/atomic.mjs';

/** 默认配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 总开关。false = 命令直接回「功能已关闭」，零 IO */
  enabled: true,
  /** 统计最近几天 */
  days: 7,
  /** 输出字数上限（QQ 群友好） */
  maxOutputChars: 300,
  /** 发言排行取几人 */
  topPeople: 5,
  /** 关键词取几个 */
  maxKeywords: 8,
  /** 是否用 LLM 叙事（false = 纯模板） */
  llmEnabled: true,
  /** LLM 超时（毫秒） */
  llmTimeoutMs: 20000,
  /** 自动周报（默认关，手动触发优先） */
  autoWeekly: false,
  /** 消息数少于此值不生成（避免空群尴尬） */
  minMessages: 30,
  /** 时区 */
  tz: 'Asia/Shanghai',
});

/** 配置文件路径。 */
export function configPathOf() {
  return join(EXT_DATA, 'memoir-config.json');
}

/**
 * 读取生效配置：默认值 ← 文件 ← 环境变量。
 *
 * @param {{ logger?: object }} [opts]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function readConfig(opts = {}) {
  const out = { ...DEFAULT_CONFIG };

  // ② 配置文件
  try {
    const j = readJsonSafe(configPathOf(), null);
    if (j && typeof j === 'object') {
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (j[k] === undefined) continue;
        out[k] = j[k];
      }
    }
  } catch { /* 坏配置用默认 */ }

  // ① 环境变量覆盖（测试隔离 / 临时调试）
  const envNum = (name, key, min = 0) => {
    const v = Number(process.env[name]);
    if (Number.isFinite(v) && v >= min) out[key] = v;
  };
  const envBool = (name, key) => {
    const v = String(process.env[name] ?? '').trim();
    if (v === '1' || v === 'true') out[key] = true;
    else if (v === '0' || v === 'false') out[key] = false;
  };
  envBool('BNN_MEMOIR_ENABLED', 'enabled');
  envBool('BNN_MEMOIR_LLM', 'llmEnabled');
  envNum('BNN_MEMOIR_DAYS', 'days', 1);
  envNum('BNN_MEMOIR_MIN_MESSAGES', 'minMessages', 0);
  envNum('BNN_MEMOIR_MAX_CHARS', 'maxOutputChars', 50);
  if (process.env.BNN_MEMOIR_TZ) out.tz = String(process.env.BNN_MEMOIR_TZ);

  // 合法性钳制（防坏配置导致异常）
  out.days = Math.max(1, Math.min(90, Number(out.days) || 7));
  out.maxOutputChars = Math.max(50, Math.min(2000, Number(out.maxOutputChars) || 300));
  out.topPeople = Math.max(1, Math.min(20, Number(out.topPeople) || 5));
  out.maxKeywords = Math.max(1, Math.min(30, Number(out.maxKeywords) || 8));
  out.minMessages = Math.max(0, Number(out.minMessages) || 30);
  out.llmTimeoutMs = Math.max(1000, Math.min(120000, Number(out.llmTimeoutMs) || 20000));

  try { opts.logger?.debug?.(`[memoir] 配置生效: ${JSON.stringify(out)}`); } catch { /* ignore */ }
  return out;
}

export default { DEFAULT_CONFIG, configPathOf, readConfig };
