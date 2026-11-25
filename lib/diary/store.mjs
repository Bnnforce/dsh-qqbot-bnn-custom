/**
 * diary/store — 日记文件的读写（R6.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 落盘结构（人格 × 群 × 日期，两级隔离）：
 *
 *   {PERSONA_ROOT}/日记/<人格名>/<群id前8位>/<YYYY-MM-DD>.md
 *
 *   PERSONA_ROOT 默认 = {工作区}/人格
 *
 * 为什么这么设计：
 *   · 人格维度：日记放人格库（"她自己的日记"），换人格换目录
 *   · 群维度：日记内容是"这个群今天的事"，必须按群隔离
 *   · 群 id 取前 8 位：与黑话本 `<gid前8位>/黑话.md` 的既有约定一致，
 *     避免目录名过长，且 8 位足以区分 6-8 个群
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 幂等 / 原子写：
 *   · 写日记用 tmp + rename（原子），防并发写坏
 *   · 同一天重复写 → 覆盖（最后一次为准）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONA_ROOT } from '../dirs.mjs';

/** 日记目录名。 */
export const DIARY_DIR = '日记';

/** 人格根（统一走 dirs.mjs，可环境变量重定向，默认 {工作区}/人格）。 */
function personaRoot() {
  return PERSONA_ROOT;
}

/** 某个人格的日记目录。 */
export function diaryRoot(persona) {
  return join(personaRoot(), DIARY_DIR, String(persona ?? '').trim());
}

/** 某个群在某人格下的日记目录。 */
export function groupDiaryDir(persona, gid) {
  return join(diaryRoot(persona), String(gid ?? '').slice(0, 8));
}

/** 某天日记文件路径。 */
export function diaryPath(persona, gid, date) {
  return join(groupDiaryDir(persona, gid), `${date}.md`);
}

/** 本地日期 YYYY-MM-DD。 */
export function ymdOf(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 昨天日期 YYYY-MM-DD。 */
export function ymdYesterday(now = Date.now()) {
  return ymdOf(Number(now) - 86400000);
}

/**
 * 写一篇日记（原子写，幂等覆盖）。失败返回 false。
 */
export function writeDiary(persona, gid, date, content, logger) {
  try {
    const p = diaryPath(persona, gid, date);
    const dir = groupDiaryDir(persona, gid);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, p);
    return true;
  } catch (e) {
    try { logger?.warn?.(`[diary] 写日记失败：${e instanceof Error ? e.message : String(e)}`); } catch { /* ignore */ }
    return false;
  }
}

/**
 * 读某天日记。失败/不存在返回 null。
 */
export function readDiary(persona, gid, date) {
  try {
    const p = diaryPath(persona, gid, date);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 列出某群已有的日记日期（降序）。失败返回 []。
 */
export function listDates(persona, gid) {
  try {
    const dir = groupDiaryDir(persona, gid);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort((a, b) => (a < b ? 1 : -1));
  } catch {
    return [];
  }
}

export default { DIARY_DIR, ymdOf, ymdYesterday, diaryRoot, diaryPath, writeDiary, readDiary, listDates };
