#!/usr/bin/env node
/**
 * memory-rollback.mjs — 从备份回滚记忆数据（R8 S2，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用途：迁移出问题时，一键恢复到备份时的状态。
 *
 * 用法：
 *   node scripts/memory-rollback.mjs              # 列出所有备份
 *   node scripts/memory-rollback.mjs --list       # 同上
 *   node scripts/memory-rollback.mjs --latest     # 回滚到最新备份
 *   node scripts/memory-rollback.mjs --at <ts>    # 回滚到指定备份
 *   node scripts/memory-rollback.mjs --at <ts> --apply   # 真正执行
 *
 * ⚠️ 默认 dry-run，加 --apply 才真正覆盖。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 记忆根（可用 BNN_MEMORY_ROOT 覆盖）。 */
const MEMORY_ROOT = String(process.env.BNN_MEMORY_ROOT || '').trim()
  || '/sdcard/DSH/Bot/dshqqbot/.qqbot-extensions/data/group-memory';

/** 备份根。 */
const BACKUP_ROOT = join(MEMORY_ROOT, '.backup');

/**
 * 列出所有备份（按时间倒序）。
 *
 * @param {string} [root]
 * @returns {Array<{ts:string, dir:string, manifest:object|null, hasGroups:boolean}>}
 */
export function listBackups(root = MEMORY_ROOT) {
  const backupRoot = join(root, '.backup');
  if (!existsSync(backupRoot)) return [];
  let dirs = [];
  try {
    dirs = readdirSync(backupRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch { return []; }

  return dirs.map((ts) => {
    const dir = join(backupRoot, ts);
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')); } catch { /* 无清单 */ }
    return {
      ts,
      dir,
      manifest,
      hasGroups: existsSync(join(dir, 'groups')),
    };
  });
}

/**
 * 执行回滚。
 *
 * @param {{root?:string, at?:string, latest?:boolean, apply?:boolean}} opts
 * @returns {object}
 */
export function rollback(opts = {}) {
  const root = String(opts.root || MEMORY_ROOT);
  const apply = opts.apply === true;
  const backups = listBackups(root);

  const result = { apply, available: backups.length, chosen: '', restored: false, reason: '' };

  if (!backups.length) {
    result.reason = '没有可用备份';
    return result;
  }

  // 选备份
  let target;
  if (opts.at) {
    target = backups.find((b) => b.ts === opts.at || b.ts.startsWith(opts.at));
    if (!target) { result.reason = `找不到备份：${opts.at}`; return result; }
  } else if (opts.latest) {
    target = backups[0];
  } else {
    result.reason = '未指定备份（用 --latest 或 --at <ts>）';
    return result;
  }

  if (!target.hasGroups) {
    result.reason = `备份不完整（缺 groups 目录）：${target.ts}`;
    return result;
  }

  result.chosen = target.ts;
  if (!apply) {
    result.reason = 'dry-run，未执行（加 --apply 真正回滚）';
    return result;
  }

  // 真正回滚：先把手头的 groups 挪开（不直接删，留后路），再复制备份
  const liveGroups = join(root, 'groups');
  const safetyDir = join(root, `.pre-rollback-${Date.now()}`);

  try {
    if (existsSync(liveGroups)) {
      renameSync(liveGroups, safetyDir);
    }
    cpSync(join(target.dir, 'groups'), liveGroups, { recursive: true });
    result.restored = true;
    result.safetyCopy = safetyDir;
    // 回滚成功后清理安全副本（可选：保留 1 份）
    try { rmSync(safetyDir, { recursive: true, force: true }); result.safetyCopy = ''; } catch { /* 留着也无妨 */ }
  } catch (e) {
    // 失败：把安全副本挪回去
    try {
      if (existsSync(liveGroups)) rmSync(liveGroups, { recursive: true, force: true });
      if (existsSync(safetyDir)) renameSync(safetyDir, liveGroups);
    } catch { /* 尽力恢复 */ }
    result.reason = `回滚失败：${e instanceof Error ? e.message : String(e)}`;
  }

  return result;
}

/** 主入口。 */
function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const latest = argv.includes('--latest');
  const atIdx = argv.indexOf('--at');
  const at = atIdx >= 0 ? argv[atIdx + 1] : '';

  const backups = listBackups();

  console.log('════ 记忆回滚 ════');
  console.log('');

  if (!backups.length) {
    console.log('  没有可用备份。');
    return;
  }

  console.log(`  可用备份（${backups.length} 个，新→旧）：`);
  for (const b of backups) {
    const m = b.manifest;
    const info = m ? `${m.reason} · ${m.totalCards ?? '?'} 卡` : '（无清单）';
    const mark = (!latest && !at && b === backups[0]) ? ' ← 最新' : '';
    console.log(`    ${b.ts}  ${info}${mark}`);
  }
  console.log('');

  if (!latest && !at) {
    console.log('  用法：');
    console.log('    --latest            回滚到最新备份');
    console.log('    --at <ts>           回滚到指定备份');
    console.log('    加 --apply          真正执行（默认干跑）');
    return;
  }

  const r = rollback({ latest, at, apply });
  if (r.reason && !r.restored) {
    console.log(`  ⓘ ${r.reason}`);
    return;
  }
  if (r.restored) {
    console.log(`  ✅ 已回滚到：${r.chosen}`);
  } else {
    console.log(`  ⓘ 将回滚到：${r.chosen}（干跑，加 --apply 执行）`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('memory-rollback.mjs')) {
  main();
}
