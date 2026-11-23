#!/usr/bin/env node
/**
 * check-syntax.mjs — 本包所有 .mjs 的语法自检
 *
 * 用法：node scripts/check-syntax.mjs
 * 退出码：0 = 全通过；1 = 有语法错误
 *
 * 为什么单独写一个（而不是 `node --check $(find ...)`）：
 *   · shell 展开在 Windows / 文件名含空格时会坏；
 *   · 本仓库要求「克隆下来就能自检」，不能依赖外部脚本。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store']);

/**
 * 用哪个可执行文件来跑 `--check`。
 *
 * ⚠️ 不能用 `process.execPath`：
 *   在 Android/Termux 上它是 `/apex/com.android.runtime/bin/linker64`（动态链接器），
 *   不是 node 本体 ⇒ 传 `--check` 会被当成脚本路径，报
 *   `error: expected absolute path: "--check"`。
 *   用 `process.argv0`（真实 node 路径）并兜底。
 */
const NODE_BIN = (() => {
  const a0 = String(process.argv0 || '');
  if (a0 && /node/i.test(a0)) return a0;
  const ep = String(process.execPath || '');
  if (ep && /node/i.test(ep)) return ep;
  return 'node';
})();

/** 递归收集 .mjs */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.mjs')) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const files = walk(ROOT);
const bad = [];

for (const f of files) {
  try {
    execFileSync(NODE_BIN, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    bad.push({ file: relative(ROOT, f), msg: String(err?.stderr ?? err?.message ?? '').slice(0, 300) });
  }
}

console.log(`检查 ${files.length} 个 .mjs`);
if (bad.length === 0) {
  console.log('✅ 语法全部通过');
  process.exit(0);
}
console.log(`❌ ${bad.length} 个文件有语法错误：`);
for (const b of bad) console.log(`\n  ${b.file}\n  ${b.msg}`);
process.exit(1);
