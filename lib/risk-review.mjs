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
/**
 * 工作区根：所有「相对路径」都相对这里解析。
 *
 * ★★ 2026-11-28 修：原来只看绝对路径前缀，于是她改自己时用的
 *    相对路径（Bot/自我/我是谁.md）被判成「工作区之外」直接拦了。
 *    实测日志：DENY hard-block name=edit reasons=工作区之外的写入
 */
const WORKSPACE_ROOT_FOR_RISK = '/sdcard/DSH';

/**
 * 把路径规范化成绝对路径（相对路径相对工作区解析）。
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';

  // 已经是绝对路径 → 原样
  if (raw.startsWith('/')) return raw;

  // 相对路径 → 相对工作区
  try {
    return `${WORKSPACE_ROOT_FOR_RISK}/${raw}`.replace(/\/+/g, '/');
  } catch {
    return raw;
  }
}

/**
 * 判断一个（已规范化的）路径属于哪个区域。
 *
 * @param {string} p 绝对路径
 * @returns {string} 区域名
 */
function zoneOf(p) {
  const s = String(p || '');
  if (!s) return 'unknown';
  if (s.startsWith(WORKSPACE_ROOT_FOR_RISK)) return 'workspace';
  if (s.startsWith(DSH_HOME)) return 'dsh';
  if (s.startsWith('/sdcard') || s.startsWith('/storage/emulated/0')) return 'shared';
  if (s.startsWith('/system') || s.startsWith('/vendor') || s.startsWith('/data/data/') || s.startsWith('/data/user/0/') === false && s.startsWith('/data/')) return 'system';
  return 'other';
}

/**
 * 判断一次文件操作的风险。
 *
 * ★★ 2026-11-28 大改（主人要求「极致自主」）：
 *
 *   旧逻辑：工作区之外 → 一律 BLOCK。
 *   问题：她要改插件本体（.dsh/plugins）、改 DSH 配置、读系统信息，
 *         全被这刀切掉了。自主性直接归零。
 *
 *   新逻辑：**分区域判定**
 *     · workspace（/sdcard/DSH）  → SAFE（她自己的地盘，随便改）
 *     · dsh（~/.dsh）             → HIGH（插件/配置/数据，放行但留痕）
 *     · shared（/sdcard 其它）    → HIGH（留痕）
 *     · system（/system 等）      → 读 SAFE / 写 HIGH（留痕）
 *     · 其它                      → 读 SAFE / 写 HIGH（留痕）
 *
 *   **只有真正不可恢复的才 BLOCK**：
 *     · 删除系统关键目录
 *     · 写入 /proc /sys /dev
 *
 *   删除操作单独判：任何删除都是 HIGH（留痕 + 备份）。
 *
 * @param {string} action 'write' | 'edit' | 'delete' | 'read'
 * @param {string} path
 * @returns {{level:string, reasons:string[], zone:string, abs:string}}
 */
export function reviewFileOp(action, path) {
  const act = String(action || '').toLowerCase();
  const abs = normalizePath(path);
  const zone = zoneOf(abs);

  // 读 → 永远 SAFE（范围由别处控制，比如群友边界）
  if (act === 'read') return { level: RISK.SAFE, reasons: [], zone, abs };

  // ★ 硬拒：内核虚拟文件系统 + 系统根目录（写了会崩系统，且不可恢复）
  if (/^\/(proc|sys|dev|system|vendor|etc|boot)(\/|$)/.test(abs)) {
    return { level: RISK.BLOCK, reasons: ['写入内核虚拟文件系统会立刻搞崩系统'], zone, abs };
  }

  const reasons = [];

  // 删除 → 高危（留痕 + 备份）
  if (act === 'delete') reasons.push('删除文件');

  // 按区域定级
  if (zone === 'workspace') {
    // 她自己的地盘：SAFE（除非是删除，上面已经加了原因）
    if (reasons.length) return { level: RISK.HIGH, reasons, zone, abs };
    return { level: RISK.SAFE, reasons: [], zone, abs };
  }

  if (zone === 'dsh') {
    reasons.push('改插件/配置/数据');
  } else if (zone === 'shared') {
    reasons.push('写工作区之外');
  } else if (zone === 'system') {
    reasons.push('改系统文件');
  } else {
    reasons.push('写未知区域');
  }

  return { level: RISK.HIGH, reasons, zone, abs };
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


/**
 * ★★ 2026-11-28 分级放行策略（主人要求：不要每步都确认）。
 *
 * ── 设计依据 ───────────────────────────────────────────────────────────────
 *
 *   hitl-guardrail 的核心：**模型建议，策略决定**。
 *   规则写在被测代码里，不在提示词里 —— 这样可复现、不随模型漂移。
 *
 * ── 为什么不是「全放开」 ───────────────────────────────────────────────────
 *
 *   全放开 = 她可以删库跑路。
 *   全拦 = 每步都要人确认，自主性归零（正是主人抱怨的现状）。
 *
 *   正解是**按影响面分级**：
 *     · 她自己的地盘 → 自动放行
 *     · 人格/规则 → 自动放行但留痕（这是她该长的部分）
 *     · 代码/配置 → 要主人（改坏了系统起不来）
 *     · 系统/内核 → 一律拒
 */

/**
 * 分区 → 放行档位。
 *
 * @param {string} zone normalizePath + zoneOf 算出来的区域
 * @param {string} action 'write' | 'edit' | 'delete' | 'read'
 * @param {string} absPath
 * @returns {{verdict:'auto'|'audit'|'ask'|'deny', reason:string}}
 */
export function decidePolicy(zone, action, absPath) {
  const act = String(action || '').toLowerCase();
  const p = String(absPath || '');
  const z = String(zone || '');

  // ── 一律拒：内核/系统 ────────────────────────────────────────────────────
  if (/^\/(proc|sys|dev|system|vendor|etc|boot)(\/|$)/.test(p)) {
    return { verdict: 'deny', reason: '系统/内核文件，碰了会崩' };
  }

  // ── 工作区（她自己的地盘）────────────────────────────────────────────────
  if (z === 'workspace') {
    // 删用户数据 → 仍然要问（可以归档不能抹）
    if (act === 'delete' && isUserDataPath(p)) {
      return { verdict: 'ask', reason: '删用户数据（群聊/记忆/日记）必须先备份确认' };
    }
    // 改代码 → 留痕（她有 self_restart 能验证语法）
    if (/\.(mjs|js|cjs|json)$/.test(p) && act !== 'read') {
      return { verdict: 'audit', reason: '改代码，留痕（三道关兜底）' };
    }
    // 其余的自我文件/人格/自主目录 → 完全自动
    return { verdict: 'auto', reason: '她自己的地盘' };
  }

  // ── DSH 插件/配置/数据 ───────────────────────────────────────────────────
  if (z === 'dsh') {
    if (act === 'read') return { verdict: 'auto', reason: '读插件配置' };
    // 改插件代码 → 要主人（改坏了整个 bot 起不来）
    if (/\/(plugins|profiles)\//.test(p)) {
      return { verdict: 'ask', reason: '改插件本体，需要主人' };
    }
    // 插件数据 → 留痕
    if (/\/data\//.test(p)) {
      return { verdict: 'audit', reason: '改插件数据，留痕' };
    }
    return { verdict: 'audit', reason: '改 DSH 内文件' };
  }

  // ── 共享存储（/sdcard 上别处）────────────────────────────────────────────
  if (z === 'shared') {
    return { verdict: 'audit', reason: '写工作区之外，留痕' };
  }

  // ── 系统/未知 ────────────────────────────────────────────────────────────
  if (z === 'system') {
    return { verdict: 'ask', reason: '改系统文件，需要主人' };
  }

  return { verdict: 'ask', reason: '未知区域，保守起见要主人' };
}

/**
 * 判断是不是用户数据路径（删了不可恢复的那种）。
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isUserDataPath(p) {
  const s = String(p || '');
  return [
    '/msg-archive/',
    '/group-memory/',
    '/group-chronicle/',
    '/life-stream/',
    '/pair-relations/',
    '/persona-evolution/',
    '/体验/',
    '/曲库/',
    '/原声库/',
  ].some((k) => s.includes(k));
}

export default {
  RISK,
  decidePolicy,
  isUserDataPath,
  reviewCommand,
  reviewFileOp,
  reviewToolCall,
  describeReview,
};
