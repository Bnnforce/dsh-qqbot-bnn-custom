/**
 * reasoning/config — 推理档位配置（2026-11-18）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计红线（为开源做准备）：
 *   ① **不写死任何本机路径** —— cwdPrefix 由调用方注入或自动推导
 *   ② **不允许硬编码 provider 名** —— 全部走配置
 *   ③ 配置非法 → 回落默认值并返回错误列表（不抛）
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const DEFAULT_REASONING_CONFIG = {
  enabled: true,

  // ── 统一模型 ──
  provider: '',
  model: '',

  // ── 推理档位 ──
  /** 官方模型用的档位。 */
  reasoningEffort: 'low',
  /** 哪些 provider 需要降档（空数组 = 全部）。 */
  effortProviders: [],

  // ── 尊重用户手动设置 ──
  /** 用户手动钉过 model 的会话 → 不抢 model（默认 true）。 */
  respectModelOverride: true,
  /** 用户手动钉过 effort 的会话 → 不抢 effort（默认 true）。 */
  respectEffortOverride: true,

  // ── 作用范围 ──
  /** 'qq' = 只 QQ 会话；'all' = 全部。 */
  scope: 'qq',
  /** QQ 会话的 cwd 前缀（空 = 自动推导，见 resolveCwdPrefix）。 */
  cwdPrefix: '',

  // ── 节律 ──
  /** 扫描间隔（仅降级定时器用；任务中心接管时不生效）。 */
  sweepMs: 5000,
};

/**
 * 合并配置（兼容旧字段名）。
 *
 * 旧版用 `respectSessionOverride` 一个字段管两件事，
 * 新版拆成 respectModelOverride / respectEffortOverride。
 * 这里做向后兼容映射，避免旧配置文件失效。
 */
export function mergeReasoningConfig(raw) {
  const c = { ...DEFAULT_REASONING_CONFIG };
  if (!raw || typeof raw !== 'object') return c;

  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    c[k] = v;
  }

  // 向后兼容：旧字段 respectSessionOverride → 两个新字段
  if (raw.respectSessionOverride !== undefined) {
    const old = raw.respectSessionOverride !== false;
    if (raw.respectModelOverride === undefined) c.respectModelOverride = old;
    if (raw.respectEffortOverride === undefined) c.respectEffortOverride = old;
  }

  return c;
}

/**
 * 校验配置，返回错误列表（空 = 合法）。
 * @param {object} cfg
 * @returns {string[]}
 */
export function validateReasoningConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['config 不是对象'];

  if (typeof cfg.enabled !== 'boolean') errs.push('enabled 必须是布尔');
  if (typeof cfg.enforceModel !== 'boolean' && cfg.enforceModel !== undefined) {
    errs.push('enforceModel 必须是布尔');
  }
  if (typeof cfg.respectModelOverride !== 'boolean') errs.push('respectModelOverride 必须是布尔');
  if (typeof cfg.respectEffortOverride !== 'boolean') errs.push('respectEffortOverride 必须是布尔');

  const eff = String(cfg.reasoningEffort ?? '').trim();
  const VALID_EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'extra_high', 'extra-high'];
  if (eff && !VALID_EFFORTS.includes(eff)) {
    errs.push(`reasoningEffort 非法: ${eff}（可选: ${VALID_EFFORTS.filter(Boolean).join('/')}）`);
  }

  if (!Array.isArray(cfg.effortProviders)) errs.push('effortProviders 必须是数组');
  if (String(cfg.scope ?? 'qq') !== 'qq' && String(cfg.scope) !== 'all') {
    errs.push("scope 必须是 'qq' 或 'all'");
  }
  if (!Number.isInteger(cfg.sweepMs) || cfg.sweepMs <= 0) errs.push('sweepMs 必须是正整数');

  return errs;
}

/**
 * 该 provider 是否要降档；返回目标档位（空串 = 不动）。
 *
 * @param {string} provider
 * @param {object} cfg
 * @returns {string}
 */
export function effortFor(provider, cfg) {
  const p = String(provider ?? '');
  const want = String(cfg?.reasoningEffort ?? '').trim();
  if (!want) return '';

  const list = Array.isArray(cfg?.effortProviders) ? cfg.effortProviders : [];
  if (list.length === 0) return want;          // 空数组 = 全部 provider
  return list.includes(p) ? want : '';
}

/**
 * 自动推导 QQ 会话的 cwd 前缀。
 *
 * 为什么需要推导：开源部署时路径不同，不能写死。
 * 推导依据：`qqbotDataRoot` 的父目录（QQ 会话的 cwd 通常在那里）。
 *
 * @param {string} qqbotDataRoot 例如 /xxx/Bot/dshqqbot
 * @returns {string} 例如 /xxx/Bot
 */
export function resolveCwdPrefix(qqbotDataRoot) {
  const p = String(qqbotDataRoot ?? '').trim();
  if (!p) return '';
  // 去掉末尾斜杠，取父目录
  const clean = p.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx > 0 ? clean.slice(0, idx) : '';
}