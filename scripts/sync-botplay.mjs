#!/usr/bin/env node
/**
 * sync-botplay.mjs — botplay 运行时副本同步（CLI 薄封装）
 *
 * 用法：
 *   node scripts/sync-botplay.mjs           # 同步（只在需要时写）
 *   node scripts/sync-botplay.mjs --check   # 只检查，不写（CI 用，有缺口退出码 1）
 *   node scripts/sync-botplay.mjs --force   # 强制全量覆盖
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它解决什么问题
 *
 *   上游 @zaofan/dsh-qqbot 的 botplay 加载器**只认**
 *   `{dataRoot}/.qqbot-extensions/botplay/<纯文件名>`，**不扫扩展包**
 *   （这是六个扩展点里唯一不支持扩展包的）。
 *
 *   而卡片里写的是相对 import（`../lib/pure/card-format.mjs`），
 *   所以必须把 `lib/` 整棵依赖树也复制过去，否则 13 张卡片全部
 *   `ERR_MODULE_NOT_FOUND`，点开报「模块加载失败」。
 *
 *   正常部署**不需要手动跑**：`hooks/zz-ensure-workspace.mjs` 在实例启动时
 *   会自动调用同一个库函数。这个 CLI 是给「排查 / CI / 手动重跑」用的。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 为什么本文件只有薄薄一层
 *
 *   核心逻辑全在 `lib/pure/botplay-sync.mjs`（纯函数、零副作用）。
 *   历史事故：把逻辑写在这里、顶层放 `process.exit(main())`，
 *   而 hook 用 `await import()` 加载 ⇒ **顶层代码被执行** ⇒ 整个 QQBot 进程被杀。
 *   所以：**能被 import 的模块绝不能有顶层副作用**。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { syncBotplayModules } from '../lib/pure/botplay-sync.mjs';
import { DATA_ROOT } from '../lib/pack-paths.mjs';

const argv = new Set(process.argv.slice(2));
const force = argv.has('--force');
const checkOnly = argv.has('--check');
const quiet = argv.has('--quiet') || argv.has('-q');

function log(...a) {
  if (!quiet) console.log(...a);
}

function main() {
  const dataRoot = String(process.env.QQBOT_DATA_ROOT || DATA_ROOT || '').trim();
  if (!dataRoot) {
    console.error('✗ 拿不到数据根（QQBOT_DATA_ROOT 与 pack-paths 都为空）');
    return 1;
  }

  log('botplay 同步（扩展包 → 上游加载位置）\n');
  log(`  数据根：${dataRoot}`);
  log(`  源：${dataRoot}/extension-packs/<pack>/botplay`);
  log(`  目标：${dataRoot}/.qqbot-extensions/botplay\n`);

  const r = syncBotplayModules({ dataRoot, force, checkOnly });

  if (r.reason === 'no-src') { log('✗ 源目录不存在，跳过'); return 0; }
  if (r.reason === 'empty-src') { console.error('✗ 源目录没有 botplay 模块'); return 1; }
  if (r.reason === 'no-data-root') { console.error('✗ 没有数据根'); return 1; }
  if (r.reason === 'read-src-failed') { console.error('✗ 读不到源目录'); return 1; }

  if (checkOnly) {
    const problems = [];
    if (r.ghosts.length) problems.push(`幽灵 ${r.ghosts.length} 个：${r.ghosts.join(', ')}`);
    if (r.missing.length) problems.push(`未同步 ${r.missing.length} 个：${r.missing.join(', ')}`);
    if (r.libMissing?.length) problems.push(`lib 未同步 ${r.libMissing.length} 个：${r.libMissing.slice(0, 5).join(', ')}`);
    if (r.botplayLibMissing?.length) problems.push(`botplay/lib 未同步 ${r.botplayLibMissing.length} 个`);
    if (problems.length) {
      console.error('✗ 未就绪：');
      for (const p of problems) console.error('   · ' + p);
      console.error('   跑 node scripts/sync-botplay.mjs 修复');
      return 1;
    }
    log(`✓ 全部已同步（卡片 ${r.total} 个 / lib ${r.libTotal ?? 0} 个 / botplay/lib ${r.botplayLibTotal ?? 0} 个）`);
    return 0;
  }

  for (const g of r.ghosts) log(`  - 清理幽灵 ${g}`);
  for (const f of r.missing) log(`  ✗ 复制失败 ${f}`);

  log(`结果：复制 ${r.copied} 个 / 跳过 ${r.skipped} 个 / 清理 ${r.removed} 个 / 共 ${r.total} 个`);
  if (r.libTotal !== undefined) {
    log(`      lib：复制 ${r.libCopied ?? 0} / 跳过 ${r.libSkipped ?? 0} / 共 ${r.libTotal}`);
  }
  if (r.botplayLibTotal !== undefined) {
    log(`      botplay/lib：复制 ${r.botplayLibCopied ?? 0} / 跳过 ${r.botplayLibSkipped ?? 0} / 共 ${r.botplayLibTotal}`);
  }
  return r.ok ? 0 : 1;
}

// ⚠️ 只有直跑才 exit；被 import 时什么都不做
function isMainModule() {
  try {
    const entry = process.argv?.[1];
    if (!entry) return false;
    const self = decodeURIComponent(new URL(import.meta.url).pathname);
    const real = decodeURIComponent(new URL('file://' + entry).pathname);
    return self === real;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main();
