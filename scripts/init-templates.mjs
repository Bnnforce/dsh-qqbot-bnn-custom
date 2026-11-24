#!/usr/bin/env node
/**
 * init-templates — 把素材模板铺到人格目录下的 `_模板/`（幂等，不覆盖已有文件）。
 *
 * 为什么放到 `_模板/` 而不是直接进 `事实库/`：
 *   事实库的扫描是按 `事实库/<人格>/音乐|番剧|书|游戏/<作品>.md` 来的，
 *   模板要是落进那些目录，会被当成"她真的喜欢这首歌"读进去 —— 白白污染人格记忆。
 *   `_模板/` 不在扫描范围内，纯当参考。
 *
 * 用法：
 *   node scripts/init-templates.mjs              # 铺到 PERSONA_ROOT/_模板/
 *   node scripts/init-templates.mjs --dry-run    # 只看会做什么
 *   node scripts/init-templates.mjs --force       # 连已存在的也覆盖（慎用）
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONA_ROOT } from '../lib/dirs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'templates');
const DEST = join(PERSONA_ROOT, '_模板');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

if (!existsSync(SRC)) {
  console.error(`❌ 找不到模板目录：${SRC}`);
  process.exit(1);
}

const files = walk(SRC);
let copied = 0;
let skipped = 0;

console.log(`模板源：${SRC}`);
console.log(`目标：  ${DEST}${dryRun ? '（dry-run，不写盘）' : ''}`);
console.log('');

for (const src of files) {
  const rel = relative(SRC, src);
  const dst = join(DEST, rel);
  if (existsSync(dst) && !force) {
    skipped += 1;
    console.log(`  跳过（已存在） ${rel}`);
    continue;
  }
  if (!dryRun) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  copied += 1;
  console.log(`  ${existsSync(dst) ? '覆盖' : '新增'} ${rel}`);
}

console.log('');
console.log(dryRun
  ? `将复制 ${copied} 个、跳过 ${skipped} 个（未写盘）`
  : `完成：复制 ${copied} 个、跳过 ${skipped} 个`);
if (!dryRun && copied > 0) {
  console.log('');
  console.log('下一步：照 _模板/ 里的文件填内容，放到对应目录 ——');
  console.log(`  事实库/音乐/<歌名>.md          → ${join(PERSONA_ROOT, '事实库')}/音乐/ 或 /<人格>/音乐/`);
  console.log(`  事实库/番剧/<番剧名>.md        → 同上`);
  console.log(`  人生清单/<人格>.md             → ${join(PERSONA_ROOT, '人生清单')}`);
  console.log(`  黑话本/<人格>.md               → ${join(PERSONA_ROOT, '黑话本')}`);
}
