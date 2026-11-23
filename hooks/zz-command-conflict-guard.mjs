/**
 * hooks/zz-command-conflict-guard — 命令冲突守卫（R5.7 工业化 2026-11-23）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 *
 *   原来我们靠**改 node_modules 里的 middleware-setup.js** 做命令去重：
 *     scripts/repair-qqbot-security.mjs 注入 QQBotSecurityPatch:cmd-dedupe
 *   这违反「不碰第三方代码」的开源规范，而且插件一升级补丁就没了。
 *
 *   实测当前状态：
 *     · 我们的扩展命令 56 个
 *     · 插件内置命令 24 个
 *     · **零冲突、零重复**
 *   ⇒ 那个补丁其实从来没起过作用（只是保险）。
 *
 *   替代方案：**在扩展层做检测**，不改插件。
 *     · 启动时扫一遍所有命令名
 *     · 有重复/冲突就**告警写日志**（不拦截，避免和插件抢控制权）
 *     · 让问题可见，而不是靠插件静默去重
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纪律
 *   · **只读不写**：绝不修改插件或其他扩展的文件
 *   · **只告警不拦截**：不改变任何命令的行为
 *   · **失败静默**：扫描出错绝不影响启动
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'command-conflict-guard';

/** 插件内置命令（从 @zaofan/dsh-qqbot/dist/commands 提取，2026-11-23 快照）。 */
const BUILTIN_COMMANDS = new Set([
  'ans', 'bot-clear', 'bot-exit', 'bot-help', 'bot-me', 'bot-model', 'bot-new',
  'bot-ping', 'bot-reset', 'bot-restart', 'bot-status', 'bot-stop', 'bot-version',
  'botplay', 'inject', 'model', 'new', 'outmode', 'perm', 'permission',
  'preset', 'presets', 'tools-reload', '权限',
]);

/** 本扩展包的 commands 目录。 */
const COMMANDS_DIR = new URL('../commands/', import.meta.url).pathname;

/**
 * 从源码里抠出命令名（支持 `name: 'x'` 和 `name: ['x','y']`）。
 *
 * @param {string} src
 * @returns {Set<string>}
 */
function namesOf(src) {
  const out = new Set();

  // name: ['a', 'b']
  const arr = src.match(/name:\s*\[([^\]]{1,400})\]/);
  if (arr) {
    for (const m of arr[1].matchAll(/['"]([^'"]{1,40})['"]/g)) out.add(m[1].toLowerCase());
  }

  // name: 'a'
  const str = src.match(/name:\s*['"]([^'"]{1,40})['"]/);
  if (str) out.add(str[1].toLowerCase());

  return out;
}

/**
 * 扫描并报告冲突。
 *
 * @param {object} logger
 * @returns {{ total:number, conflicts:string[], duplicates:string[] }}
 */
function scan(logger) {
  /** name → [文件名] */
  const owner = new Map();
  const duplicates = [];
  const conflicts = [];

  let files = [];
  try {
    files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'));
  } catch (e) {
    logger?.warn?.('[命令守卫] 读不到 commands 目录: ' + String(e?.message || e));
    return { total: 0, conflicts: [], duplicates: [] };
  }

  for (const f of files) {
    let src = '';
    try { src = readFileSync(join(COMMANDS_DIR, f), 'utf8'); } catch { continue; }

    for (const n of namesOf(src)) {
      if (owner.has(n)) {
        duplicates.push(`/${n} 同时定义在 ${owner.get(n)} 和 ${f}`);
      } else {
        owner.set(n, f);
        if (BUILTIN_COMMANDS.has(n)) {
          conflicts.push(`/${n}（${f}）与插件内置命令重名`);
        }
      }
    }
  }

  return { total: owner.size, conflicts, duplicates };
}

export async function run(env) {
  const logger = env?.logger;

  try {
    const r = scan(logger);

    if (r.total === 0) return 'no-commands';

    if (r.conflicts.length === 0 && r.duplicates.length === 0) {
      logger?.info?.(`[命令守卫] ${r.total} 个命令，无冲突`);
      return `ok(total=${r.total})`;
    }

    // 有冲突 → 醒目告警（但不拦截）
    for (const c of r.conflicts) logger?.warn?.('[命令守卫] 冲突: ' + c);
    for (const d of r.duplicates) logger?.warn?.('[命令守卫] 重复: ' + d);

    // 同时写一份到数据目录，方便事后查
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join: pjoin, dirname } = await import('node:path');
      const { EXT_DATA } = await import('../lib/pack-paths.mjs');
      const out = pjoin(EXT_DATA, 'command-conflicts.log');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, [
        '# ' + new Date().toISOString(),
        ...r.conflicts.map((x) => '冲突: ' + x),
        ...r.duplicates.map((x) => '重复: ' + x),
      ].join('\n') + '\n', 'utf8');
    } catch { /* 写不了就算了 */ }

    return `warn(conflicts=${r.conflicts.length},dups=${r.duplicates.length})`;
  } catch (e) {
    logger?.warn?.('[命令守卫] 扫描异常（已忽略）: ' + String(e?.message || e));
    return 'error';
  }
}

/** 导出给测试用。 */
export { BUILTIN_COMMANDS, scan, namesOf };

export default { name, run };
