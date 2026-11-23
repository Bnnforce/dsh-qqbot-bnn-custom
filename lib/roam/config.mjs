/**
 * roam/config — 上网逛逛的全部参数（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计红线（与 points/config.mjs、wake-lottery/config.mjs 同款）：
 *   ① 不允许硬编码本机路径 —— 数据根由 pack-paths 统一提供
 *   ② 不允许硬编码人格名 / 群 id
 *   ③ 所有时间口径统一走 timezone
 *   ④ 非法配置一律回落默认值，**绝不抛**
 *
 * 配置来源优先级（从高到低）：
 *   1. 环境变量 BNN_ROAM_*（测试隔离 / 临时覆盖）
 *   2. {EXT_DATA}/roam-config.json（用户可改）
 *   3. DEFAULT_CONFIG（兜底）
 *
 * ⚠️ 所有环境变量都在**调用时**读取，不在模块加载时冻结。
 *    （本项目踩过一次：模块级 const ROOT = process.env.X 会冻住测试覆盖。）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT } from '../pack-paths.mjs';

/** 配置文件名（扁平，跟随 wake-lottery / memoir 惯例）。 */
export const CONFIG_FILE_NAME = 'roam-config.json';

/** 数据目录名（只放运行状态，不放配置）。 */
export const STATE_DIR_NAME = 'roam';

/** 诊断日志文件名。 */
export const DIAG_FILE_NAME = 'roam-diag.log';

/**
 * 默认配置。
 *
 * ⚠️ 这些是「默认」，不是「写死的魔法数字」——
 *    调用方总是传 resolveConfig() 的结果。
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 总开关。默认关：灰度上线，先自己群开。 */
  enabled: false,
  /** 最长时长（秒）。超了不看——长视频字幕太长、抽帧太多。 */
  maxDurationSec: 1800,
  /** 最短时长（秒）。太短没内容可聊。
   *  ⚠️ 2026-11-23 打磨：60 → 30。实测她经常挑到 40-50 秒的短视频，
   *  60 秒门槛导致白跑一次（多一次网络请求 + 4 秒）。30 秒既能挡住真·短片段，又不会过度过滤。 */
  minDurationSec: 30,
  /** 字幕截断上限（字符）。18954 字太贵，截到 3000。 */
  subtitleMaxChars: 3000,
  /** 是否走画面通道。 */
  videoshotEnabled: true,
  /** 下几张雪碧图（1 张 = 100 帧，够判断调性）。 */
  videoshotMaxPages: 1,
  /** 说出来的字数上限。硬约束，防她念稿。 */
  promptMaxChars: 70,   // ⚠️ 2026-11-23 从 40 提到 70：40 字说不清「是什么+感受」两层
  /** 每群每小时最多响应几个链接。 */
  perGroupHourlyCap: 2,
  /** 每人每小时最多 /看 几次。 */
  perUserHourlyCap: 3,
  /** 每天最多主动逛几次。 */
  dailyProactiveCap: 2,
  /** 主动逛时的分享形态。
   *   always（默认）= 一定发卡片 + 一句话
   *   sometimes = 一半概率发卡，一半只说话
   *   never = 只说话不发卡（等于退化成 life-stream，不建议）
   */
  proactiveShareMode: 'always',
  /** 两次主动逛的最小间隔（毫秒）。 */
  roamIntervalMs: 3 * 3600 * 1000,
  /** 已看列表保留条数（LRU）。 */
  seenKeepCount: 200,
  /** 元数据缓存 TTL（毫秒）。
   *  ⚠️ 2026-11-23 调优：原来 1 小时太短 —— 用户隔天再 /看 同一支会因缓存过期
   *  而重新抓一次（没必要，元数据基本不变）。改成 7 天。 */
  metadataTtlMs: 7 * 24 * 3600 * 1000,
  /** WBI 密钥缓存 TTL（毫秒）。密钥几小时才变。 */
  wbiKeyTtlMs: 30 * 60 * 1000,
  /** 遇风控重试几次。 */
  retryOnRiskControl: 3,
  /** 退避序列（毫秒）。 */
  retryBackoffMs: [5000, 10000, 15000],
  /** 全局最小请求间隔（毫秒）。实测 1.2s 稳定。 */
  minIntervalMs: 1500,
  /** 连续几次风控后熔断。 */
  circuitBreakAfter: 3,
  /** 熔断时长（毫秒）。 */
  circuitBreakMs: 30 * 60 * 1000,
  /** 装死窗：这个小时段不主动开口（被动可响应）。 */
  sleepWindow: Object.freeze({ start: 2, end: 6 }),
  /** 时区。 */
  timezone: 'Asia/Shanghai',
  /** ★ 全局发言预算：两次主动发言之间至少隔多久（跨功能共享）。
   *  2026-11-23 新增：实测 TEST 群一天机器人 22 条 / 群友 19 条，她比人说得还多。
   *  R5.7 主动逛 + R5.6 抽奖 + life-stream 各说各的，加起来就刷屏。 */
  globalMinGapMs: 2 * 3600 * 1000,
  /** ★ 全局日上限：一个群一天最多被主动打扰几次（跨功能共享）。 */
  globalDailyCap: 8,
  /** ⚠️ 临时测试开关：true 时 hook 会立刻触发一次主动逛，用完自动改回 false。
   *  只用于真机验证，生产保持 false。 */
  testNow: false,
});

/** 数值型字段的合法范围（防配置写炸）。 */
const NUM_RANGES = Object.freeze({
  maxDurationSec: [10, 4 * 3600],
  minDurationSec: [1, 600],
  subtitleMaxChars: [0, 80000],
  videoshotMaxPages: [1, 6],
  promptMaxChars: [20, 200],
  // proactiveShareMode 是枚举，单独校验
  perGroupHourlyCap: [0, 20],
  perUserHourlyCap: [0, 20],
  dailyProactiveCap: [0, 10],
  roamIntervalMs: [10 * 60 * 1000, 24 * 3600 * 1000],
  globalMinGapMs: [60 * 1000, 12 * 3600 * 1000],
  globalDailyCap: [1, 30],
  seenKeepCount: [10, 5000],
  metadataTtlMs: [60 * 1000, 30 * 24 * 3600 * 1000],
  wbiKeyTtlMs: [60 * 1000, 24 * 3600 * 1000],
  retryOnRiskControl: [0, 5],
  minIntervalMs: [300, 10000],
  circuitBreakAfter: [1, 10],
  circuitBreakMs: [60 * 1000, 24 * 3600 * 1000],
});

/** 环境变量映射：字段名 → 环境变量名后缀。 */
const ENV_SUFFIX = Object.freeze({
  enabled: 'ENABLED',
  subtitleMaxChars: 'SUBTITLE_MAX_CHARS',
  videoshotEnabled: 'VIDEOSHOT_ENABLED',
  videoshotMaxPages: 'VIDEOSHOT_PAGES',
  promptMaxChars: 'PROMPT_MAX_CHARS',
  perGroupHourlyCap: 'GROUP_CAP',
  perUserHourlyCap: 'USER_CAP',
  dailyProactiveCap: 'DAILY_CAP',
  commaIntervalMs: 'INTERVAL_MS',
  roamIntervalMs: 'INTERVAL_MS',
  minIntervalMs: 'MIN_INTERVAL_MS',
  maxDurationSec: 'MAX_DURATION',
  minDurationSec: 'MIN_DURATION',
});

/** 当前数据根（调用时求值，不冻结）。 */
export function dataRoot() {
  return String(process.env.QQBOT_DATA_ROOT || DATA_ROOT || '').trim();
}

/** 配置文件绝对路径。 */
export function configFile() {
  return join(dataRoot(), '.qqbot-extensions', 'data', CONFIG_FILE_NAME);
}

/** 状态目录绝对路径。 */
export function stateDir() {
  return join(dataRoot(), '.qqbot-extensions', 'data', STATE_DIR_NAME);
}

/** 诊断日志绝对路径（可被 BNN_ROAM_DIAG 覆盖）。 */
export function diagFile() {
  const o = String(process.env.BNN_ROAM_DIAG || '').trim();
  if (o) return o;
  return join(dataRoot(), '.qqbot-extensions', 'data', DIAG_FILE_NAME);
}

/**
 * 把一个值夹到合法范围里。
 * 非有限数字 → 回落默认；超出范围 → 夹到边界。
 */
function clampNum(value, fallback, range) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const [lo, hi] = range;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** 解析布尔（支持 '1'/'0'/'true'/'false'/'yes'/'no'）。 */
function parseBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  }
  return fallback;
}

/** 解析整数数组（退避序列）。非法则回落默认。 */
function parseNumArray(value, fallback, lo, hi) {
  const arr = Array.isArray(value) ? value : null;
  if (!arr || arr.length === 0) return [...fallback];
  const out = [];
  for (const x of arr) {
    const n = Number(x);
    if (Number.isFinite(n)) out.push(Math.min(hi, Math.max(lo, Math.round(n))));
  }
  return out.length > 0 ? out : [...fallback];
}

/** 解析装死窗。 */
function parseSleepWindow(value, fallback) {
  const rec = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!rec) return { ...fallback };
  const start = Number(rec.start);
  const end = Number(rec.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ...fallback };
  const s = Math.min(23, Math.max(0, Math.round(start)));
  const e = Math.min(24, Math.max(0, Math.round(end)));
  return { start: s, end: e };
}

/**
 * 解析配置：合并「环境变量 → 文件 → 默认值」，逐字段做类型守卫。
 *
 * @param {object} [raw] 已从文件读到的原始对象（不传则自己读）
 * @returns {Readonly<object>} 保证字段齐全、类型正确，**绝不抛**
 */
export function resolveConfig(raw) {
  // 1) 从文件读（只在没显式传 raw 时）
  let fromFile = {};
  if (raw === undefined) {
    try {
      const f = configFile();
      if (existsSync(f)) {
        const parsed = JSON.parse(readFileSync(f, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fromFile = parsed;
      }
    } catch {
      // 文件坏了当不存在 —— 配置问题绝不能让她整条链路挂掉
      fromFile = {};
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    fromFile = raw;
  }

  const d = DEFAULT_CONFIG;
  const cfg = {};

  // 2) 布尔字段
  cfg.enabled = parseBool(fromFile.enabled, d.enabled);
  cfg.videoshotEnabled = parseBool(fromFile.videoshotEnabled, d.videoshotEnabled);
  cfg.testNow = parseBool(fromFile.testNow, d.testNow);

  // 3) 数值字段
  for (const [key, range] of Object.entries(NUM_RANGES)) {
    cfg[key] = clampNum(fromFile[key], d[key], range);
  }

  // 4) 数组字段
  cfg.retryBackoffMs = parseNumArray(fromFile.retryBackoffMs, d.retryBackoffMs, 1000, 120000);

  // 5) 对象字段
  cfg.sleepWindow = parseSleepWindow(fromFile.sleepWindow, d.sleepWindow);

  // 6) 字符串字段
  cfg.timezone = typeof fromFile.timezone === 'string' && fromFile.timezone.trim()
    ? fromFile.timezone.trim()
    : d.timezone;

  // 6.5) 枚举字段
  const MODES = ['always', 'sometimes', 'never'];
  cfg.proactiveShareMode = MODES.includes(fromFile.proactiveShareMode)
    ? fromFile.proactiveShareMode
    : d.proactiveShareMode;

  // 7) 环境变量覆盖（最高优先级）
  for (const [key, suffix] of Object.entries(ENV_SUFFIX)) {
    if (!(key in cfg)) continue;
    const envVal = process.env['BNN_ROAM_' + suffix];
    if (envVal === undefined) continue;
    if (typeof cfg[key] === 'boolean') {
      cfg[key] = parseBool(envVal, cfg[key]);
    } else if (typeof cfg[key] === 'number') {
      cfg[key] = clampNum(envVal, cfg[key], NUM_RANGES[key] || [0, Number.MAX_SAFE_INTEGER]);
    }
  }

  return Object.freeze(cfg);
}

/** 当前时刻（可被 BNN_ROAM_NOW 冻住，测试用）。 */
export function nowMs() {
  const o = String(process.env.BNN_ROAM_NOW || '').trim();
  if (o) {
    const n = Number(o);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now();
}

export default {
  CONFIG_FILE_NAME,
  STATE_DIR_NAME,
  DIAG_FILE_NAME,
  DEFAULT_CONFIG,
  resolveConfig,
  dataRoot,
  configFile,
  stateDir,
  diagFile,
  nowMs,
};
