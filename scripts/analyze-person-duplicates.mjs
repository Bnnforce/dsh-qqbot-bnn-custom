#!/usr/bin/env node
/**
 * analyze-person-duplicates.mjs — 人物卡跨群重复分析（R8 S2，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 只读分析，绝不修改任何数据。
 *
 * 目的：找出「同一个 openid 在多个群各存一张卡」的情况。
 *
 * 背景：group-memory 的人物卡是**按群存的**：
 *   groups/<gid>/entities/people/<昵称>.md
 * 同一个人出现在 6 个群，就有 6 张卡，各记一部分信息。
 *
 * 用法：
 *   node scripts/analyze-person-duplicates.mjs
 *   node scripts/analyze-person-duplicates.mjs --json   # 机器可读
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 记忆根（可用 BNN_MEMORY_ROOT 覆盖，便于测试）。 */
const MEMORY_ROOT = String(process.env.BNN_MEMORY_ROOT || '').trim()
  || '/sdcard/DSH/Bot/dshqqbot/.qqbot-extensions/data/group-memory';

const PEOPLE_SUBDIR = join('entities', 'people');

/** 安全读文本。 */
function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 列出子目录。 */
function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

/**
 * 从人物卡里提取 openid。
 *
 * 已知格式：`- 群成员：X（别名）；openid：<32位hex>。`
 *          也有 `- openid：<32位hex>。`
 * 用宽松匹配，兼容全角/半角冒号。
 *
 * @param {string} text
 * @returns {string} 32 位 hex，找不到返回空串
 */
export function extractOpenid(text) {
  const t = String(text ?? '');
  const m = t.match(/openid[：:]\s*([0-9A-Fa-f]{32})/);
  return m ? m[1] : '';
}

/**
 * 从人物卡里提取昵称（文件名去掉 .md）。
 * @param {string} filename
 * @returns {string}
 */
export function extractName(filename) {
  return String(filename ?? '').replace(/\.md$/, '');
}

/**
 * 从人物卡里提取「群」名（`- 群：XXX（gid）。`）。
 * @param {string} text
 * @returns {string}
 */
export function extractGroupName(text) {
  const t = String(text ?? '');
  const m = t.match(/-\s*群[：:]\s*(.+?)（[0-9A-Fa-f]{32}）/);
  return m ? m[1].trim() : '';
}

/**
 * 判断一张卡的信息量（用于选主卡）。
 *
 * 计分：Current 段每行 +1，History 段每行 +2，Related 段每行 +1。
 * 有生日/别名等高价值信息额外加分。
 *
 * @param {string} text
 * @returns {number}
 */
export function scoreCard(text) {
  const t = String(text ?? '');
  const section = (name) => {
    const re = new RegExp(`##\\s*${name}([\\s\\S]*?)(?=##|$)`);
    const m = t.match(re);
    return m ? m[1] : '';
  };
  const lines = (s) => s.split('\n').filter((l) => l.trim().startsWith('- ')).length;

  let score = 0;
  score += lines(section('Current')) * 1;
  score += lines(section('History')) * 2;
  score += lines(section('Related')) * 1;
  // 高价值信息加分
  if (/生日[：:]/.test(t)) score += 5;
  if (/别名[：:]/.test(t)) score += 3;
  if (/备注[：:]/.test(t)) score += 2;
  return score;
}

/**
 * 扫描所有人物卡。
 *
 * @param {string} [root]
 * @returns {Array<{gid:string, name:string, openid:string, groupName:string, score:number, path:string, text:string}>}
 */
export function scanCards(root = MEMORY_ROOT) {
  const groupsRoot = join(root, 'groups');
  const out = [];
  for (const gid of listDirs(groupsRoot)) {
    const dir = join(groupsRoot, gid, PEOPLE_SUBDIR);
    if (!existsSync(dir)) continue;
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      const text = readText(path);
      if (!text) continue;
      out.push({
        gid,
        name: extractName(f),
        openid: extractOpenid(text),
        groupName: extractGroupName(text),
        score: scoreCard(text),
        path,
        text,
      });
    }
  }
  return out;
}

/**
 * 按 openid 分组，找出重复。
 *
 * @param {Array<object>} cards
 * @returns {{duplicates: Array, total: number, unique: number, noOpenid: Array}}
 */
export function findDuplicates(cards) {
  const byOpenid = new Map();
  const noOpenid = [];

  for (const c of cards) {
    if (!c.openid) { noOpenid.push(c); continue; }
    if (!byOpenid.has(c.openid)) byOpenid.set(c.openid, []);
    byOpenid.get(c.openid).push(c);
  }

  const duplicates = [];
  for (const [openid, list] of byOpenid) {
    if (list.length < 2) continue;
    // 按信息量降序，第一张是「最全的」
    const sorted = [...list].sort((a, b) => b.score - a.score);
    duplicates.push({
      openid,
      count: list.length,
      names: [...new Set(list.map((c) => c.name))],
      groups: list.map((c) => ({ gid: c.gid, groupName: c.groupName, name: c.name, score: c.score })),
      primary: { gid: sorted[0].gid, name: sorted[0].name, score: sorted[0].score },
    });
  }

  // 按重复数降序
  duplicates.sort((a, b) => b.count - a.count);

  return {
    duplicates,
    total: cards.length,
    unique: byOpenid.size,
    noOpenid,
  };
}

/** 主入口。 */
function main() {
  const asJson = process.argv.includes('--json');
  const cards = scanCards();
  const r = findDuplicates(cards);

  if (asJson) {
    console.log(JSON.stringify({
      total: r.total,
      unique: r.unique,
      duplicateCount: r.duplicates.length,
      duplicates: r.duplicates.map((d) => ({
        openid: d.openid,
        count: d.count,
        names: d.names,
        groups: d.groups.map((g) => ({ gid: g.gid, name: g.name, score: g.score })),
      })),
      noOpenid: r.noOpenid.map((c) => ({ gid: c.gid, name: c.name })),
    }, null, 2));
    return;
  }

  console.log('════ 人物卡跨群重复分析 ════');
  console.log('');
  console.log(`  卡片总数：${r.total}`);
  console.log(`  唯一 openid：${r.unique}`);
  console.log(`  有重复的人数：${r.duplicates.length}`);
  if (r.noOpenid.length) console.log(`  ⚠️ 无 openid 的卡：${r.noOpenid.length}`);
  console.log('');

  if (!r.duplicates.length) {
    console.log('  ✅ 没有跨群重复');
    return;
  }

  console.log('  ── 重复明细（按重复数降序）──');
  for (const d of r.duplicates) {
    console.log('');
    console.log(`  openid: ${d.openid.slice(0, 8)}…  （${d.count} 张）`);
    console.log(`  称呼: ${d.names.join(' / ')}`);
    console.log(`  主卡建议: ${d.primary.name}（${d.primary.gid.slice(0, 8)}，信息量 ${d.primary.score}）`);
    for (const g of d.groups) {
      const mark = g.gid === d.primary.gid ? ' ★主卡' : '';
      console.log(`    · ${g.gid.slice(0, 8)}  ${g.name.padEnd(12)}  ${g.groupName || '(群名未知)'}  信息量=${g.score}${mark}`);
    }
  }

  console.log('');
  console.log('  ── 汇总 ──');
  const redundant = r.duplicates.reduce((s, d) => s + (d.count - 1), 0);
  console.log(`  如果全部去重：${r.total} 张 → ${r.total - redundant} 张（减少 ${redundant} 张）`);
  console.log('');
  console.log('  下一步：node scripts/migrate-person-dedupe.mjs           # 干跑看方案');
  console.log('          node scripts/migrate-person-dedupe.mjs --apply  # 真正执行');
}

// 只在直接执行时跑 main（被 import 时不跑，便于测试）
if (process.argv[1] && process.argv[1].endsWith('analyze-person-duplicates.mjs')) {
  main();
}
