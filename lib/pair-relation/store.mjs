/**
 * pair-relation/store.mjs — 「关系可见」成对关系的落盘层
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件：
 *   infer.mjs 只负责「消息流 → 互动 Map」的纯计算，结果是一次性的。
 *   但 close（熟）是「长期积累」的关系：互动次数要跨多次消息累计，
 *   首次达到阈值的时间（establishedAt）也要记住。所以必须有一层把
 *   累计结果持久化到磁盘，下次进来接着累加，而不是从零重算。
 *
 *   落盘结构（按群隔离）：
 *     {EXT_DATA}/pair-relations/{gid}.json
 *     { "A|B": { interactions, lastSeenAt, close, establishedAt }, ... }
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么数据根从 pack-paths.mjs 的 EXT_DATA 取，而不是硬编码：
 *   ① 测试会用 QQBOT_DATA_ROOT 把数据根改道到临时目录，硬编码 /storage/...
 *      会让测试直接污染生产数据、或写到不存在的地方。
 *   ② 路径推导逻辑只有 pack-paths.mjs 一处，本文件只消费 EXT_DATA，
 *      不重复发明「.qqbot-extensions/data」怎么拼。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 踩过的坑：
 *   ① 原子写必须「写 tmp 再 rename」。直接 writeFileSync 目标文件，中途崩溃
 *      会留下半截 JSON，下次 JSON.parse 直接挂 → readPairs 返回 {} → 数据丢。
 *      所以 writePairs 一律 tmp + rename（与 diary/store.mjs 同风格）。
 *   ② rename 前要确保目录存在。mkdirSync recursive 幂等，可放心先建。
 *   ③ establishedAt「已 close 不覆盖」：不能在每次判定时都写 now，否则
 *      首次达到 close 的时间会被反复刷新，失去「什么时候熟的」这个语义。
 *      只有从非 close → close 的那一次才落 now。
 *   ④ 防膨胀：只保留 close 的 pair + 未达标但 30 天内有互动的 pair。
 *      否则群聊久了文件无限增长。用 lastSeenAt 判断（超过 30 天的未达标对删掉）。
 *   ⑤ 判定 close 用 infer.mjs 的 CLOSE_THRESHOLD，不要在这里再定义一个
 *      一模一样的魔数，两处不一致会埋雷。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA } from '../pack-paths.mjs';
import { CLOSE_THRESHOLD } from './infer.mjs';

/** 成对关系数据目录名（挂在 EXT_DATA 下）。 */
const PAIR_DIR = 'pair-relations';

/** 未达标 pair 的保留窗口：30 天。 */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 数据基目录。dataRoot 为空时用 pack-paths.mjs 的 EXT_DATA；
 * 传了则按「数据根 + .qqbot-extensions/data」拼（与 pack-paths.mjs 约定一致）。
 */
function baseDir(dataRoot) {
  if (dataRoot == null || String(dataRoot).trim() === '') return EXT_DATA;
  return join(String(dataRoot), '.qqbot-extensions', 'data');
}

/**
 * 某个群的成对关系文件路径。
 * @param {string} [dataRoot] 数据根（空则用 EXT_DATA）。
 * @param {string} gid 群 id。
 * @returns {string} `${base}/pair-relations/${gid}.json`
 */
export function pairFile(dataRoot, gid) {
  return join(baseDir(dataRoot), PAIR_DIR, `${String(gid ?? '')}.json`);
}

/**
 * 读某个群的成对关系对象。失败/不存在返回 {}。
 * @returns {{ [key: string]: { interactions:number, lastSeenAt:number, close:boolean, establishedAt?:number } }}
 */
export function readPairs(dataRoot, gid) {
  try {
    const p = pairFile(dataRoot, gid);
    if (!existsSync(p)) return {};
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/**
 * 原子写某个群的成对关系对象（tmp + rename）。失败返回 false。
 */
export function writePairs(dataRoot, gid, obj) {
  try {
    const p = pairFile(dataRoot, gid);
    const dir = join(baseDir(dataRoot), PAIR_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(obj ?? {}, null, 2), 'utf8');
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/** 统一遍历「互动计数」：兼容 Map 与普通对象。 */
function forEachInteraction(interactions, cb) {
  if (interactions instanceof Map) {
    for (const [k, v] of interactions.entries()) cb(k, v);
  } else if (interactions && typeof interactions === 'object') {
    for (const k of Object.keys(interactions)) cb(k, interactions[k]);
  }
}

/**
 * 把一次新推断出的互动累加到落盘对象，并原子写回。
 *
 * @param {string} [dataRoot] 数据根（空则用 EXT_DATA）。
 * @param {string} gid 群 id。
 * @param {Map<string, number>} interactions 本次推断的互动计数（inferInteractions 输出）。
 * @param {number} now 当前时间戳 ms。
 * @returns {{ [key: string]: { interactions:number, lastSeenAt:number, close:boolean, establishedAt?:number } }}
 *   合并后的最终对象（与已落盘内容一致）。
 *
 * 合并规则：
 *   · 互动次数累加到已有记录；
 *   · lastSeenAt 更新为 now（仅对本次有互动的 pair）；
 *   · close = interactions >= CLOSE_THRESHOLD；
 *   · establishedAt 首次达到 close 时落 now，已 close 不覆盖；
 *   · 只保留 close 的 pair + 未达标但最近 30 天内有互动的 pair。
 */
export function applyInteractions(dataRoot, gid, interactions, now) {
  const nowMs = Number(now);
  const nowSafe = Number.isFinite(nowMs) ? nowMs : Date.now();

  const existing = readPairs(dataRoot, gid);

  // ① 累加互动 + 更新 lastSeenAt（只对本次有新互动的 pair）
  forEachInteraction(interactions, (key, count) => {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return;
    const rec = existing[key];
    if (rec && typeof rec === 'object') {
      rec.interactions = (Number(rec.interactions) || 0) + n;
    } else {
      existing[key] = { interactions: n };
    }
    existing[key].lastSeenAt = nowSafe;
  });

  // ② 判定 close / establishedAt，并清理过期 pair
  for (const key of Object.keys(existing)) {
    const rec = existing[key];
    if (!rec || typeof rec !== 'object') {
      delete existing[key];
      continue;
    }
    const n = Number(rec.interactions) || 0;
    const last = Number(rec.lastSeenAt);
    const wasClose = rec.close === true;

    rec.close = n >= CLOSE_THRESHOLD;
    if (rec.close) {
      // 首次达到 close 才落 now；已 close 不覆盖 establishedAt
      if (!wasClose) {
        rec.establishedAt = nowSafe;
      } else if (!Number.isFinite(Number(rec.establishedAt))) {
        // 容错：历史数据 close 但缺 establishedAt，补一次
        rec.establishedAt = nowSafe;
      }
    } else {
      // 未达 close 不该有 establishedAt
      delete rec.establishedAt;
    }

    // 只保留 close 的 + 未达标但最近 30 天内有互动的
    const keep = rec.close || (Number.isFinite(last) && nowSafe - last <= RECENT_MS);
    if (!keep) delete existing[key];
  }

  writePairs(dataRoot, gid, existing);
  return existing;
}

export default { pairFile, readPairs, writePairs, applyInteractions };
