/**
 * msg-archive — 群消息长期存档（2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个模块：
 *
 *   官方通道的 `.qqbot/msg-history/` **只保留 7 天**
 *   （启动时 + 每 200 次写清理过期文件）。
 *
 *   而 R7 的「群共同经历」需要**长期历史**才能提炼出「一起经历过什么」。
 *   不做存档 ⇒ 7 天前的数据永久丢失 ⇒ 群史永远只有最近一周。
 *
 *   这是 R7 开始前**最紧急的一件事**：越早开始抄，将来数据越厚。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 设计：
 *   · 只抄**当天**的文件（官方清理是整日删除，抄当天即可）
 *   · 抄到 {EXT_DATA}/msg-archive/group_<gid>/<date>.jsonl
 *   · 已存在且大小相同则跳过（幂等，不重复写）
 *   · 干跑只算不写（测试用）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DATA_ROOT, EXT_DATA } from './pack-paths.mjs';

/** 存档根。 */
export const ARCHIVE_ROOT = join(EXT_DATA, 'msg-archive');

/**
 * 把 msg-history 的当天文件抄进长期存档。
 *
 * @param {object} [opts]
 * @param {string} [opts.dataRoot]   qqbot 数据根（默认 DATA_ROOT）
 * @param {string} [opts.archiveRoot] 存档根（默认 ARCHIVE_ROOT）
 * @param {string} [opts.date]       只抄这一天（YYYY-MM-DD，省略则抄全部现有文件）
 * @param {boolean} [opts.dryRun]    只算不写
 * @returns {{ scanned: number, copied: number, skipped: number, bytes: number }}
 */
export function archiveMessages(opts = {}) {
  // ★ 2026-11-26：显式传空串 = 明确要求「不处理」，不要回落默认值。
  //   否则测试隔离（传空目录）会意外扫到生产数据。
  const hasExplicitRoot = Object.prototype.hasOwnProperty.call(opts, 'dataRoot');
  const dataRoot = hasExplicitRoot
    ? String(opts.dataRoot || '').trim()
    : String(DATA_ROOT || '').trim();
  const archiveRoot = String(opts.archiveRoot || ARCHIVE_ROOT || '').trim();
  const onlyDate = String(opts.date || '').trim();
  const dryRun = opts.dryRun === true;

  const out = { scanned: 0, copied: 0, skipped: 0, bytes: 0 };
  if (!dataRoot) return out;

  const histRoot = join(dataRoot, '.qqbot', 'msg-history');
  if (!existsSync(histRoot)) return out;

  let groupDirs;
  try {
    groupDirs = readdirSync(histRoot).filter((d) => d.startsWith('group_'));
  } catch { return out; }

  for (const gdir of groupDirs) {
    const srcDir = join(histRoot, gdir);
    let files;
    try {
      files = readdirSync(srcDir).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const f of files) {
      out.scanned += 1;
      if (onlyDate && !f.startsWith(onlyDate)) continue;

      const src = join(srcDir, f);
      const dstDir = join(archiveRoot, gdir);
      const dst = join(dstDir, f);

      // 已存在且大小一致 → 跳过（幂等）
      try {
        if (existsSync(dst) && statSync(dst).size === statSync(src).size) {
          out.skipped += 1;
          continue;
        }
      } catch { /* 继续走复制 */ }

      if (dryRun) { out.copied += 1; continue; }

      try {
        const buf = readFileSync(src);
        mkdirSync(dstDir, { recursive: true });
        writeFileSync(dst, buf);
        out.copied += 1;
        out.bytes += buf.length;
      } catch { /* 单个文件失败不影响其他 */ }
    }
  }
  return out;
}

/** 统计存档总量（便于主人看「攒了多少」）。 */
export function archiveStats(opts = {}) {
  const archiveRoot = String(opts.archiveRoot || ARCHIVE_ROOT || '').trim();
  const out = { groups: 0, files: 0, bytes: 0 };
  if (!existsSync(archiveRoot)) return out;
  let dirs;
  try { dirs = readdirSync(archiveRoot).filter((d) => d.startsWith('group_')); } catch { return out; }
  out.groups = dirs.length;
  for (const d of dirs) {
    let fs2;
    try { fs2 = readdirSync(join(archiveRoot, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    out.files += fs2.length;
    for (const f of fs2) {
      try { out.bytes += statSync(join(archiveRoot, d, f)).size; } catch { /* ignore */ }
    }
  }
  return out;
}
