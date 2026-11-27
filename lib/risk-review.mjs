/**
 * risk-review — 高危操作识别与审查（R9，2026-11-28）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人的要求：
 *
 *   「权限限制导致她大部分自主能力受限 → 做完整放开，
 *     但是做识别高危，动手自动审查。」
 *
 * ── 设计原则 ───────────────────────────────────────────────────────────────
 *
 *   放开 ≠ 不管。放开的是**权限**，加严的是**审查**：
 *
 *     以前：不确定能不能做 → 一律拒（安全但死板）
 *     现在：默认放行 → 但高危操作**先过审查**，审查不过才拒
 *
 * ── 三层判定 ───────────────────────────────────────────────────────────────
 *
 *   ① 硬禁区（永远拒，不审查）
 *      · 设备/屏幕（已下线）
 *      · 工作区之外的写（/system、其他 app 的数据）
 *      · 明显的破坏性命令（rm -rf /、格式化、dd 到块设备）
 *
 *   ② 高危（**放行但先审查**）
 *      · 删文件（rm / unlink / delete）
 *      · 改系统文件（插件代码、任务清单）
 *      · 批量操作（一次改多个群、群发）
 *      · 权限相关（踢人、禁言、改设置）
 *      · 长时间/高成本（大量 shell、外部 API 循环）
 *
 *   ③ 普通（直接放行，不审查）
 *      · 读文件、查资料、写自己的自我文件、跑测试
 *
 * ── 审查怎么做 ─────────────────────────────────────────────────────────────
 *
 *   纯规则先跑（快、不花钱）：
 *     · 路径在不在允许范围
 *     · 命令里有没有黑名单模式
 *     · 影响范围（几个文件/几个群）
 *
 *   规则过了但风险等级仍是 high → 可选 LLM 二次判（拿不到就按「规则结论」走）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME
  || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';

/** 风险等级。 */
export const RISK = Object.freeze({
  SAFE: 'safe',       // 直接放行
  HIGH: 'high',       // 放行但审查
  BLOCK: 'block',     // 一律拒
});

/**
 * 硬禁区：命令行里出现就拒（不分身份）。
 *
 * ⚠️ 这些是**不可恢复**的操作，给什么都不该放行。
 */
const HARD_BLOCK_PATTERNS = Object.freeze([
  // 删根目录 / 系统目录
  /rm\s+(--?[a-zA-Z-]+\s+)*\/(\s|$)/,
  /rm\s+(--?[a-zA-Z-]+\s+)*\/(system|vendor|data|proc|sys)(\/|\s|$)/,
  // 格式化 / 写块设备
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /\bfdisk\b/,
  /\bparted\b/,
  // 改设备权限 / 刷机
  /\bflash\b.*\.(img|bin)/,
  /\bfastboot\b/,
  // 清理所有进程（会杀掉 DSH 自己和用户的其他 app）
  /\bkillall\b/,
  /\bpkill\s+-9\s+-f\s+\.\s*$/,
  // 改系统属性
  /\bsetprop\b/,
]);

/**
 * 高危模式：放行但审查。
 */
const HIGH_RISK_PATTERNS = Object.freeze([
  // 删除
  { re: /\brm\b|\bunlink\b|\brmdir\b/, why: '删除文件' },
  // 移动/覆盖
  { re: /\bmv\b[^\n]*\s\/dev\/null/, why: '丢弃文件' },
  { re: />\s*\/dev\/sd/, why: '写块设备' },
  // 权限
  { re: /\bchmod\s+[0-7]{3,4}\s+\//, why: '改系统权限' },
  { re: /\bchown\b/, why: '改所有者' },
  // 网络下载并执行
  { re: /\bcurl\b[^\n]*\|\s*(ba)?sh/, why: '下载即执行' },
  { re: /\bwget\b[^\n]*\|\s*(ba)?sh/, why: '下载即执行' },
  // 包管理
  { re: /\bpkg\s+(install|uninstall)\b/, why: '装/卸软件包' },
  { re: /\bpip\s+install\b/, why: '装 Python 包' },
  { re: /\bnpm\s+(i|install)\s+-g\b/, why: '全局装 npm 包' },
  // git 破坏性
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+--force)/, why: 'git 破坏性操作' },
  // 杀进程（可能连自己）
  { re: /\bkill\s+-9\s+\d+/, why: '强杀进程' },
]);

/** 写出到这些路径 → 高危。 */
const SENSITIVE_WRITE_ROOTS = Object.freeze([
  join(DSH_HOME, 'plugins'),
  join(DSH_HOME, 'profiles'),
  join(DSH_HOME, 'data'),
  '/sdcard/DSH/Bot/任务中心',
]);

/** 判断路径是否敏感。 */
function isSensitivePath(p) {
  const s = String(p || '');
  if (!s) return false;
  return SENSITIVE_WRITE_ROOTS.some((r) => s === r || s.startsWith(r + '/'));
}

/**
 * 判断一段 shell 命令的风险。
 *
 * @param {string} command
 * @returns {{level:string, reasons:string[]}}
 */
export function reviewCommand(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return { level: RISK.SAFE, reasons: [] };

  // ① 硬禁区
  for (const re of HARD_BLOCK_PATTERNS) {
    if (re.test(cmd)) {
      return { level: RISK.BLOCK, reasons: ['不可恢复的危险命令，一律拒绝'] };
    }
  }

  // ② 高危
  const reasons = [];
  for (const { re, why } of HIGH_RISK_PATTERNS) {
    if (re.test(cmd)) reasons.push(why);
  }
  if (reasons.length) return { level: RISK.HIGH, reasons };

  return { level: RISK.SAFE, reasons: [] };
}

/**
 * 判断一次文件操作的风险。
 *
 * @param {string} action 'write' | 'edit' | 'delete' | 'read'
 * @param {string} path
 * @returns {{level:string, reasons:string[]}}
 */
export function reviewFileOp(action, path) {
  const act = String(action || '').toLowerCase();
  const p = String(path || '');

  // 读 → 永远安全（范围由别处控制）
  if (act === 'read') return { level: RISK.SAFE, reasons: [] };

  const reasons = [];

  // 删除 → 高危
  if (act === 'delete') reasons.push('删除文件');

  // 写系统路径 → 高危
  if (isSensitivePath(p)) reasons.push('改系统/插件文件');

  // 写工作区之外 → 硬拒
  //   ⚠️ 顺序很重要：先判敏感路径（高危），再判工作区外（硬拒）——
  //      插件目录在 DSH_HOME 下，应该算「高危放行」而不是「硬拒」。
  const inWorkspace = p.startsWith('/sdcard/') || p.startsWith('/storage/emulated/0') || p.startsWith(DSH_HOME);
  if (p && !inWorkspace) {
    return { level: RISK.BLOCK, reasons: ['工作区之外的写入，一律拒绝'] };
  }

  if (reasons.length) return { level: RISK.HIGH, reasons };
  return { level: RISK.SAFE, reasons: [] };
}

/**
 * 判断一次工具调用的风险（统一入口）。
 *
 * @param {string} toolName
 * @param {object} args
 * @returns {{level:string, reasons:string[]}}
 */
export function reviewToolCall(toolName, args = {}) {
  const name = String(toolName || '');

  // bash → 查命令
  if (name === 'bash' || name === 'shell' || name === 'terminal_send') {
    return reviewCommand(args?.command ?? args?.cmd ?? args?.text ?? '');
  }

  // 文件操作 → 查路径
  if (name === 'write' || name === 'create') {
    return reviewFileOp('write', args?.file_path ?? args?.path ?? args?.file ?? '');
  }
  if (name === 'edit' || name === 'str_replace_editor') {
    return reviewFileOp('edit', args?.file_path ?? args?.path ?? args?.file ?? '');
  }
  if (name === 'delete' || name === 'remove') {
    return reviewFileOp('delete', args?.file_path ?? args?.path ?? args?.file ?? '');
  }

  return { level: RISK.SAFE, reasons: [] };
}

/**
 * 组装审查说明（给 LLM 或给日志）。
 *
 * @param {string} toolName
 * @param {object} args
 * @param {{level:string, reasons:string[]}} risk
 * @returns {string}
 */
export function describeReview(toolName, args, risk) {
  const lines = [
    `工具：${toolName}`,
    `风险：${risk.level}`,
    `原因：${risk.reasons.join('、') || '无'}`,
  ];
  try {
    const a = JSON.stringify(args ?? {}).slice(0, 300);
    lines.push(`参数：${a}`);
  } catch { /* ignore */ }
  return lines.join('\n');
}

export { HARD_BLOCK_PATTERNS, HIGH_RISK_PATTERNS, SENSITIVE_WRITE_ROOTS };

export default {
  RISK,
  reviewCommand,
  reviewFileOp,
  reviewToolCall,
  describeReview,
};
