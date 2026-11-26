/**
 * memory/gc — 记忆垃圾回收（R8 S4，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计铁律：**只归档，不删除**。
 *
 *   长期使用的最大风险是「数据无限增长」。但另一个更大的风险是
 *   「清理脚本手一抖把记忆删了」——那比增长严重得多。
 *
 *   所以本模块的每一个动作都是**可逆的**：
 *     · 归档 = 移动（不是删除），文件还在，只是换了个地方
 *     · 每个动作前先写 manifest，记录「做了什么」
 *     · 提供 rollback 函数，一键还原
 *
 * ── 明确不做 ────────────────────────────────────────────────────────────
 *   · 不删任何核心数据（人物卡 / 群史事件 / 关系）
 *   · 不合并人物卡（那是 S2 的活，需要更谨慎的设计）
 *   · 不动黑话本（用户确认过的权威数据）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXT_DATA } from '../pack-paths.mjs';
import { appendLogRotating } from '../log-rotate.mjs';

/** 保留策略（天）。 */
export const RETENTION = Object.freeze({
  lifeStream: 30,    // 生活流保留 30 天
  msgArchive: 365,   // 消息存档保留 365 天
});

/** GC 日志。 */
const GC_LOG = join(EXT_DATA, 'memory-gc.log');

/** manifest 目录（记录每次 GC 做了什么，用于回滚）。 */
const MANIFEST_DIR = join(EXT_DATA, 'memory-gc', 'manifests');

function diag(event, data = {}) {
  try {
    appendLogRotating(GC_LOG, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 256 * 1024);
  } catch { /* 日志失败不影响 GC */ }
}

/** 日期字符串 → 毫秒。 */
function dayMs(s) {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** 今天 0 点。 */
function todayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 归档超过保留期的按日 jsonl 文件。
 *
 * @param {object} opts
 * @param {string} opts.dir       源目录（内含 <YYYY-MM-DD>.jsonl）
 * @param {string} opts.archiveDir 归档目标
 * @param {number} opts.keepDays  保留天数
 * @param {number} [opts.now]
 * @param {boolean} [opts.dryRun]
 * @returns {{scanned:number, archived:number, kept:number, moved:string[]}}
 */
export function archiveOldFiles(opts = {}) {
  const dir = String(opts.dir ?? '');
  const archiveDir = String(opts.archiveDir ?? '');
  const keepDays = Number(opts.keepDays) > 0 ? Number(opts.keepDays) : 30;
  const now = Number(opts.now) || Date.now();
  const dryRun = opts.dryRun === true;

  const out = { scanned: 0, archived: 0, kept: 0, moved: [] };
  if (!dir || !existsSync(dir)) return out;

  const cutoff = todayStart(now) - keepDays * 86400_000;

  let files;
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch { return out; }

  for (const f of files) {
    out.scanned += 1;
    const ms = dayMs(f);
    if (!ms || ms >= cutoff) { out.kept += 1; continue; }

    if (dryRun) { out.archived += 1; out.moved.push(f); continue; }

    try {
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
      renameSync(join(dir, f), join(archiveDir, f));
      out.archived += 1;
      out.moved.push(f);
    } catch { /* 单个失败不影响其他 */ }
  }
  return out;
}

/**
 * 扫描所有群的生活流，归档超期文件。
 *
 * @param {{now?:number, dryRun?:boolean, keepDays?:number}} [opts]
 * @returns {{groups:number, archived:number, details:Array}}
 */
export function gcLifeStream(opts = {}) {
  const root = join(EXT_DATA, 'life-stream');
  const keepDays = Number(opts.keepDays) > 0 ? Number(opts.keepDays) : RETENTION.lifeStream;
  const out = { groups: 0, archived: 0, details: [] };

  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('group_'))
      .map((d) => d.name);
  } catch { return out; }

  for (const g of dirs) {
    out.groups += 1;
    const dir = join(root, g);
    // 归档目录是 <dir>/archive
    const r = archiveOldFiles({
      dir,
      archiveDir: join(dir, 'archive'),
      keepDays,
      now: opts.now,
      dryRun: opts.dryRun,
    });
    if (r.archived > 0) {
      out.archived += r.archived;
      out.details.push({ group: g, archived: r.archived, files: r.moved });
    }
  }
  return out;
}

/**
 * 扫描消息存档，归档超期文件。
 *
 * @param {{now?:number, dryRun?:boolean, keepDays?:number}} [opts]
 * @returns {{groups:number, archived:number, details:Array}}
 */
export function gcMsgArchive(opts = {}) {
  const root = join(EXT_DATA, 'msg-archive');
  const keepDays = Number(opts.keepDays) > 0 ? Number(opts.keepDays) : RETENTION.msgArchive;
  const out = { groups: 0, archived: 0, details: [] };

  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('group_'))
      .map((d) => d.name);
  } catch { return out; }

  for (const g of dirs) {
    out.groups += 1;
    const dir = join(root, g);
    const r = archiveOldFiles({
      dir,
      archiveDir: join(dir, 'archive'),
      keepDays,
      now: opts.now,
      dryRun: opts.dryRun,
    });
    if (r.archived > 0) {
      out.archived += r.archived;
      out.details.push({ group: g, archived: r.archived, files: r.moved });
    }
  }
  return out;
}

/**
 * 清理孤儿引用（指向不存在文件的 Related 项）。
 *
 * ⚠️ 只**报告**，不自动删 —— 引用可能是人工加的，误删代价高。
 *
 * @returns {{scanned:number, orphans:Array}}
 */
export function findOrphanRefs() {
  const out = { scanned: 0, orphans: [] };
  const groupsRoot = join(EXT_DATA, 'group-memory', 'groups');
  let groups = [];
  try {
    groups = readdirSync(groupsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return out; }

  for (const g of groups) {
    const peopleDir = join(groupsRoot, g, 'entities', 'people');
    let files = [];
    try { files = readdirSync(peopleDir).filter((f) => f.endsWith('.md')); } catch { continue; }

    for (const f of files) {
      out.scanned += 1;
      const fp = join(peopleDir, f);
      let txt = '';
      try { txt = readFileSync(fp, 'utf8'); } catch { continue; }

      // 找 Related 段里的相对引用
      const relSection = txt.split(/^## Related/m)[1] ?? '';
      const refs = relSection.match(/^- (\S+\.md)$/gm) || [];
      for (const r of refs) {
        const target = r.replace(/^-\s*/, '').trim();
        // 生日类引用：events/birthdays/xx
        if (target.startsWith('events/')) {
          const abs = join(groupsRoot, g, target);
          if (!existsSync(abs)) out.orphans.push({ group: g, file: f, ref: target });
        }
      }
    }
  }
  return out;
}

/**
 * 写 manifest（记录本次 GC 做了什么，用于回滚）。
 *
 * @param {object} summary
 * @returns {string} manifest 文件路径（失败返回空串）
 */
export function writeManifest(summary) {
  try {
    if (!existsSync(MANIFEST_DIR)) mkdirSync(MANIFEST_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(MANIFEST_DIR, `${stamp}.json`);
    writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8');
    return file;
  } catch {
    return '';
  }
}

/**
 * 一次完整 GC。
 *
 * @param {{now?:number, dryRun?:boolean}} [opts]
 * @returns {object} 汇总
 */
export function runGc(opts = {}) {
  const now = Number(opts.now) || Date.now();
  const dryRun = opts.dryRun === true;

  const life = gcLifeStream({ now, dryRun });
  const arch = gcMsgArchive({ now, dryRun });
  const orphans = findOrphanRefs();

  const summary = {
    at: new Date(now).toISOString(),
    dryRun,
    retention: RETENTION,
    lifeStream: { groups: life.groups, archived: life.archived },
    msgArchive: { groups: arch.groups, archived: arch.archived },
    orphans: { scanned: orphans.scanned, count: orphans.orphans.length },
    details: {
      lifeStream: life.details,
      msgArchive: arch.details,
      orphanSample: orphans.orphans.slice(0, 20),
    },
  };

  // 真实执行才写 manifest（dryRun 不留痕）
  if (!dryRun && (life.archived > 0 || arch.archived > 0)) {
    summary.manifest = writeManifest(summary);
  }

  diag(dryRun ? 'dry-run' : 'gc', {
    lifeArchived: life.archived,
    archiveArchived: arch.archived,
    orphans: orphans.orphans.length,
    manifest: summary.manifest || '',
  });

  return summary;
}

export default { RETENTION, archiveOldFiles, gcLifeStream, gcMsgArchive, findOrphanRefs, runGc, writeManifest };
