/**
 * sync-tools.mjs — 扩展工具同步（CLI 薄封装，2026-11-27 R9）
 *
 * 用法：
 *   node scripts/sync-tools.mjs           # 同步（只在需要时写）
 *   node scripts/sync-tools.mjs --check   # 只检查，不写（CI 用，有缺口退出码 1）
 *   node scripts/sync-tools.mjs --force   # 强制全量覆盖
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它解决什么问题
 *
 *   上游的工具加载器**扫两个目录**（ext-packs.js 的 scanExtFiles）：
 *     · {dataRoot}/.qqbot-extensions/tools/   ← 老位置（用户自己的工具）
 *     · {dataRoot}/extension-packs/<包>/tools/ ← 扩展包位置
 *
 *   两处都扫意味着：同名工具会**出现两次**，谁生效取决于加载顺序。
 *   实测血案（2026-11-27）：改了扩展包那份，但运行时那份是旧的且先加载
 *   ⇒ 群里调用仍跑旧代码，四次都没修好。
 *
 *   实测血案（2026-11-27）：
 *     改了 扩展包/tools/self_restart.mjs 四次，群里调用仍然报旧错误 ——
 *     因为运行时读的是 .qqbot-extensions/tools/ 下那份**从没更新过**的副本。
 *     而且 tools_reload 也刷不掉「改已有工具的逻辑」（上游注释明确写了）。
 *
 * ── 额外检查：运行时副本必须自包含 ─────────────────────────────────────────
 *
 *   运行时目录拿不到扩展包的 `../lib/` 和 `./lib/`。
 *   如果工具 import 了这些相对路径，放过去就加载失败。
 *
 *   所以本脚本会**扫一遍 import**，发现相对路径就报错（除非 --allow-relative）。
 *   正确做法：把需要的逻辑内联进工具本身。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT } from '../lib/pack-paths.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');
const allowRelative = args.includes('--allow-relative');

function log(...a) {
  console.log(...a);
}

/** 找出全部 .mjs（不递归子目录 —— 上游只扫直接子文件）。 */
function listTools(srcDir) {
  try {
    return readdirSync(srcDir)
      .filter((f) => /\.(mjs|js|cjs)$/.test(f))
      .filter((f) => {
        try { return statSync(join(srcDir, f)).isFile(); } catch { return false; }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * 检查一个工具文件的相对 import（运行时副本会失效的那种）。
 *
 * @param {string} file
 * @returns {string[]} 有问题的 import 目标
 */
function findRelativeImports(file) {
  const bad = [];
  try {
    const s = readFileSync(file, 'utf8');
    // 匹配 import ... from '...' 和 import('...')
    const re = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const target = m[1];
      if (target.startsWith('.') || target.startsWith('/')) bad.push(target);
    }
  } catch { /* ignore */ }
  return bad;
}

/**
 * 判断一个工具是不是「占位壳」（故意停用、只为阻止示例回填）。
 *
 * 为什么要单独识别：
 *   扩展包里有些同名文件是 `export const disabled = true` 的空壳
 *   （例如 bing_search.mjs —— 停用示例工具，但必须在位，否则插件又会把示例铺回来）。
 *   这类文件**绝不能同步到运行时**，否则会覆盖掉那边真正的实现。
 *
 * @param {string} file
 * @returns {boolean}
 */
function isPlaceholder(file) {
  try {
    const s = readFileSync(file, 'utf8');
    return /export\s+const\s+disabled\s*=\s*true/.test(s);
  } catch {
    return false;
  }
}

function main() {
  const dataRoot = String(process.env.QQBOT_DATA_ROOT || DATA_ROOT || '').trim();
  if (!dataRoot) {
    console.error('✗ 拿不到数据根（QQBOT_DATA_ROOT 与 pack-paths 都为空）');
    return 1;
  }

  // 源：扩展包的 tools/
  const packDir = join(dataRoot, 'extension-packs', 'bnn-custom');
  const srcDir = join(packDir, 'tools');
  const dstDir = join(dataRoot, '.qqbot-extensions', 'tools');

  log('tools 同步（扩展包 → 上游加载位置）\n');
  log(`  数据根：${dataRoot}`);
  log(`  源：${srcDir}`);
  log(`  目标：${dstDir}\n`);

  if (!existsSync(srcDir)) {
    log('✓ 源目录不存在（这个包没工具），跳过');
    return 0;
  }

  const files = listTools(srcDir);
  if (!files.length) {
    console.error('✗ 源目录没有工具模块');
    return 1;
  }

  // ① 依赖检查：**只警告同步到运行时的副本**
  //
  //    扩展包里的工具可以有相对 import（它和 ../lib/ 在一起，能跑）。
  //    同步到 {dataRoot}/.qqbot-extensions/tools/ 的那份就不行了 —— 那里没有 lib。
  //
  //    所以策略：只同步「自包含」的工具到运行时；有相对 import 的**只留在扩展包**。
  const withRel = [];
  for (const f of files) {
    const bad = findRelativeImports(join(srcDir, f));
    if (bad.length) withRel.push({ file: f, imports: bad });
  }
  //    还要排除「占位壳」（export const disabled = true）—— 它们只是挡示例回填，
  //    同步过去会覆盖运行时的真实现。
  const placeholders = files.filter((f) => isPlaceholder(join(srcDir, f)));
  const selfContained = files
    .filter((f) => !withRel.some((w) => w.file === f))
    .filter((f) => !placeholders.includes(f));

  if (withRel.length) {
    log(`  注：${withRel.length} 个工具用了相对 import（留在扩展包，不同步到运行时）：`);
    for (const w of withRel) log(`     · ${w.file}`);
    log(`  自包含可同步：${selfContained.length} 个\n`);
  }

  if (placeholders.length) {
    log(`  注：${placeholders.length} 个占位壳（停用工具，不同步）：${placeholders.join(', ')}\n`);
  }

  if (checkOnly) {
    const missing = [];
    const stale = [];
    for (const f of selfContained) {
      const src = join(srcDir, f);
      const dst = join(dstDir, f);
      if (!existsSync(dst)) { missing.push(f); continue; }
      try {
        const a = readFileSync(src, 'utf8');
        const b = readFileSync(dst, 'utf8');
        if (a !== b) stale.push(f);
      } catch { stale.push(f); }
    }
    // 幽灵：运行时有、但本包不产出的工具
    //   ⚠️ 这些可能是**用户自己的工具**（qq_send / vote / session_* 等），
    //   清了就是事故。所以只提示，绝不算失败。
    const ghosts = listTools(dstDir).filter((f) => !selfContained.includes(f));

    if (missing.length || stale.length) {
      console.error('✗ 未就绪：');
      if (missing.length) console.error(`   · 未同步 ${missing.length} 个：${missing.join(', ')}`);
      if (stale.length) console.error(`   · 过期 ${stale.length} 个：${stale.join(', ')}`);
      console.error('   跑 node scripts/sync-tools.mjs 修复');
      return 1;
    }
    log(`✓ 全部已同步（${selfContained.length} 个自包含工具）`);
    if (ghosts.length) {
      log(`  注：运行时另有 ${ghosts.length} 个本包不管的工具（不动）：${ghosts.slice(0, 6).join(', ')}${ghosts.length > 6 ? ' …' : ''}`);
    }
    return 0;
  }

  // ② 同步
  try { mkdirSync(dstDir, { recursive: true }); } catch { /* ignore */ }

  let copied = 0;
  let skipped = 0;
  const failed = [];

  for (const f of selfContained) {
    const src = join(srcDir, f);
    const dst = join(dstDir, f);
    try {
      if (!force && existsSync(dst)) {
        const a = readFileSync(src, 'utf8');
        const b = readFileSync(dst, 'utf8');
        if (a === b) { skipped += 1; continue; }
      }
      copyFileSync(src, dst);
      copied += 1;
      log(`  ✓ ${f}`);
    } catch (e) {
      failed.push(f);
      log(`  ✗ ${f}（${String(e).slice(0, 60)}）`);
    }
  }

  // ③ 幽灵只报告，**不清理**
  //
  //    运行时目录里可能有用户自己的工具（qq_send / vote / session_* …），
  //    那些不归扩展包管，清了就是事故。
  const ghosts = listTools(dstDir).filter((f) => !selfContained.includes(f));
  const removed = 0;
  if (ghosts.length) {
    log('');
    log(`  注：运行时还有 ${ghosts.length} 个本包不管的工具（不动）：${ghosts.slice(0, 6).join(', ')}${ghosts.length > 6 ? ' …' : ''}`);
  }

  log('');
  log(`结果：复制 ${copied} / 跳过 ${skipped} / 清理 ${removed} / 共 ${selfContained.length} 个自包含工具`);
  if (failed.length) {
    console.error(`✗ 失败 ${failed.length} 个：${failed.join(', ')}`);
    return 1;
  }
  log('✓ 完成');
  return 0;
}

// ⚠️ 只有直跑才 exit；被 import 时什么都不做
function isMainModule() {
  try {
    return process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/)/, ''));
  } catch { return false; }
}

if (isMainModule()) {
  process.exitCode = main();
}

export { main, findRelativeImports, listTools };
