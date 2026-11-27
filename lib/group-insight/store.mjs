/**
 * store — 群认知读写（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 数据目录：
 *   {EXT_DATA}/group-insight/<gid>/
 *     ├── topics.jsonl       话题历史（每天追加，幂等）
 *     ├── atmosphere.json    群氛围（覆盖写，最新）
 *     └── summary.md         综合认知（每月重写，本模块暂不生成）
 *
 * 隐私：<gid> 是群标识，输出内容不含 openid。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readdirSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA } from '../pack-paths.mjs';

/** 群认知根目录。 */
export function insightRoot() {
  return join(EXT_DATA, 'group-insight');
}

/** 某群的目录。 */
export function groupDir(gid) {
  const bare = String(gid ?? '').replace(/^group_/, '').replace(/[^A-Za-z0-9_-]/g, '');
  return join(insightRoot(), bare);
}

/**
 * 读某群近 N 天的消息（按日期文件）。
 *
 * @param {string} gid
 * @param {number} [days] 默认 3
 * @returns {Array<object>}
 */
export function readRecentMessages(gid, days = 3) {
  const archiveDir = join(EXT_DATA, 'msg-archive', `group_${String(gid ?? '').replace(/^group_/, '').replace(/[^A-Za-z0-9_-]/g, '')}`);
  if (!existsSync(archiveDir)) return [];

  let files = [];
  try {
    files = readdirSync(archiveDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .slice(-Math.max(1, Number(days) || 3));
  } catch { return []; }

  const out = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(archiveDir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

/**
 * 写话题（追加，幂等：同一天不重复写）。
 *
 * @param {string} gid
 * @param {string} date YYYY-MM-DD
 * @param {Array<object>} topics
 * @returns {boolean}
 */
export function writeTopics(gid, date, topics) {
  const dir = groupDir(gid);
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'topics.jsonl');

    // 幂等：同一天已写则跳过
    const entry = { date, topics };
    const line = JSON.stringify(entry) + '\n';
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      if (raw.includes(`"date":"${date}"`)) return false;
    }
    appendFileSync(file, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 写氛围（覆盖，最新）。
 *
 * @param {string} gid
 * @param {object} atmosphere
 * @param {string} [date]
 * @returns {boolean}
 */
export function writeAtmosphere(gid, atmosphere, date) {
  const dir = groupDir(gid);
  try {
    mkdirSync(dir, { recursive: true });
    const entry = { at: date || new Date().toISOString().slice(0, 10), ...atmosphere };
    writeFileSync(join(dir, 'atmosphere.json'), JSON.stringify(entry, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 列出所有有存档的群。 */
export function listGroups() {
  const archiveDir = join(EXT_DATA, 'msg-archive');
  try {
    return readdirSync(archiveDir)
      .filter((f) => f.startsWith('group_'))
      .map((f) => f.replace(/^group_/, ''));
  } catch {
    return [];
  }
}

export default {
  insightRoot, groupDir, readRecentMessages, writeTopics, writeAtmosphere, listGroups,
};
