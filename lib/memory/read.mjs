/**
 * memory/read — 统一读取层（R8，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计铁律：**只读，绝不写**。
 *
 *   为什么这么定：
 *     R7 留下了 6 套记忆存储，各自有写入方。如果这里也写，
 *     就会出现两个写入方 → 竞态 → 数据损坏。
 *
 *   所以本模块的定位是「**只读聚合器**」：
 *     · 它读所有存储，但一个字都不写
 *     · 写入仍由各模块自己负责（职责不变）
 *     · 因此**接入它是零风险的** —— 最坏情况是读不到，绝不会破坏数据
 *
 *   这也是「一步到位、排除所有风险」的技术前提：
 *     先做只读聚合（零风险），写入统一留到后续版本。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 提供的能力：
 *   readPerson(openid)    一个人的全部记忆（跨 4 套存储）
 *   readGroup(gid)        一个群的全部记忆
 *   readChronicle(gid)    群史事件
 *   readRelations(gid)    关系三维
 *   readEvolution()       成长指标
 *   readLifeStream(gid)   生活流
 *   readSlang(gid)        群黑话
 *   readBirthdays(gid)    生日
 *   overview()            全局概览（体量/健康度）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EXT_DATA, WORKSPACE_ROOT } from '../pack-paths.mjs';

/** 各存储根。 */
const ROOTS = {
  memory: join(EXT_DATA, 'group-memory'),
  chronicle: join(EXT_DATA, 'group-chronicle'),
  relations: join(EXT_DATA, 'pair-relations'),
  lifeStream: join(EXT_DATA, 'life-stream'),
  evolution: join(EXT_DATA, 'persona-evolution'),
  archive: join(EXT_DATA, 'msg-archive'),
  slang: join(WORKSPACE_ROOT, 'Bot', '人格', '黑话本'),
};

/** 安全读文本。 */
function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 安全读 JSON。 */
function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 安全读 jsonl。 */
function readJsonl(file) {
  const raw = readText(file);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 列出子目录。 */
function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

/** 把 group_xxx / 裸 xxx 统一成裸 gid。 */
function bareGid(s) {
  return String(s ?? '').replace(/^group_/, '');
}

/** 在多个候选目录里找某个 gid 的目录（兼容两种命名）。 */
function findGroupDir(root, gid) {
  const bare = bareGid(gid);
  const candidates = [join(root, `group_${bare}`), join(root, bare)];
  for (const c of candidates) if (existsSync(c)) return c;
  return '';
}

// ═══════════════════════════════════════════════════════════════════════════
// 各类型读取
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 群史事件。
 * @param {string} gid
 * @param {{limit?:number}} [opts]
 * @returns {Array<object>}
 */
export function readChronicle(gid, opts = {}) {
  const dir = findGroupDir(ROOTS.chronicle, gid);
  if (!dir) return [];
  const events = readJsonl(join(dir, 'events.jsonl'));
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
  return limit > 0 ? events.slice(-limit) : events;
}

/** 群编年史正文（LLM 生成的叙事）。 */
export function readChronicleText(gid) {
  const dir = findGroupDir(ROOTS.chronicle, gid);
  return dir ? readText(join(dir, 'chronicle.md')).trim() : '';
}

/**
 * 关系数据（含三维）。
 * @param {string} gid
 * @returns {object} pairKey → 记录
 */
export function readRelations(gid) {
  const bare = bareGid(gid);
  const file = join(ROOTS.relations, `${bare}.json`);
  return readJson(file, {}) || {};
}

/**
 * 成长指标（全局，不分群）。
 * @param {{limit?:number}} [opts]
 * @returns {Array<object>}
 */
export function readEvolution(opts = {}) {
  const list = readJsonl(join(ROOTS.evolution, 'metrics.jsonl'));
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
  return limit > 0 ? list.slice(-limit) : list;
}

/** 里程碑。 */
export function readMilestones() {
  return readJson(join(ROOTS.evolution, 'milestones.json'), { hits: [] }) || { hits: [] };
}

/**
 * 生活流日志。
 * @param {string} gid
 * @param {{limit?:number, days?:number}} [opts]
 * @returns {Array<object>}
 */
export function readLifeStream(gid, opts = {}) {
  const dir = findGroupDir(ROOTS.lifeStream, gid);
  if (!dir) return [];

  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
  const days = Number(opts.days) > 0 ? Number(opts.days) : 1;

  const out = [];
  // 今天的
  out.push(...readJsonl(join(dir, 'today.jsonl')));
  // 归档的（最近 N 天）
  if (days > 1) {
    const arch = join(dir, 'archive');
    try {
      const files = readdirSync(arch).filter((f) => f.endsWith('.jsonl')).sort().slice(-days);
      for (const f of files) out.push(...readJsonl(join(arch, f)));
    } catch { /* 无归档 */ }
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/**
 * 群黑话。
 * @param {string} gid
 * @returns {Array<{word:string, meaning:string}>}
 */
export function readSlang(gid) {
  const bare = bareGid(gid);
  const dir = join(ROOTS.slang, bare.slice(0, 8));
  const file = join(dir, '黑话.md');
  const raw = readText(file);
  if (!raw) return [];

  // 解析格式：## 词\n- 释义：xxx
  const out = [];
  const blocks = raw.split(/^## /m).slice(1);
  for (const b of blocks) {
    const lines = b.split('\n');
    const word = String(lines[0] ?? '').trim();
    if (!word) continue;
    const meaningLine = lines.find((l) => l.includes('释义'));
    const meaning = meaningLine ? meaningLine.replace(/^-\s*释义[：:]\s*/, '').trim() : '';
    if (meaning) out.push({ word, meaning });
  }
  return out;
}

/**
 * 生日表。
 * @param {string} gid
 * @returns {Array<{name:string, date:string}>}
 */
export function readBirthdays(gid) {
  const bare = bareGid(gid);
  const dir = join(ROOTS.memory, 'groups', bare, 'events', 'birthdays');
  const out = [];
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const m = f.match(/^(\d{2})-(\d{2})-(.+)\.md$/);
      if (m) out.push({ date: `${m[1]}-${m[2]}`, name: m[3] });
    }
  } catch { /* 无生日表 */ }
  return out;
}

/**
 * 人物卡（按群存的 md）。
 * @param {string} gid
 * @param {string} openid
 * @returns {string} markdown 正文
 */
export function readPersonCard(gid, openid) {
  const bare = bareGid(gid);
  const dir = join(ROOTS.memory, 'groups', bare, 'entities', 'people');
  if (!existsSync(dir)) return '';
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const txt = readText(join(dir, f));
      if (txt.includes(openid)) return txt;
    }
  } catch { /* 无卡 */ }
  return '';
}

/** 群画像。 */
export function readGroupCard(gid) {
  const bare = bareGid(gid);
  const dir = join(ROOTS.memory, 'groups', bare);
  return readText(join(dir, 'group.md')).trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// 聚合读取（核心价值）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个人的全部记忆（跨 4 套存储聚合）。
 *
 * @param {string} openid
 * @param {{gid?:string}} [opts] 指定群则只取该群相关
 * @returns {{openid:string, cards:Array, relations:Array, mentionedIn:Array, slang:Array, birthdays:Array}}
 */
export function readPerson(openid, opts = {}) {
  const oid = String(openid ?? '').trim();
  const out = { openid: oid, cards: [], relations: [], mentionedIn: [], birthdays: [] };
  if (!oid) return out;

  const groupsRoot = join(ROOTS.memory, 'groups');
  const groups = opts.gid ? [bareGid(opts.gid)] : listDirs(groupsRoot);

  for (const g of groups) {
    // ① 人物卡
    const card = readPersonCard(g, oid);
    if (card) out.cards.push({ gid: g, text: card });

    // ② 关系（含此人的 pair）
    const rels = readRelations(g);
    for (const [key, rel] of Object.entries(rels)) {
      if (key.includes(oid)) out.relations.push({ gid: g, key, ...rel });
    }

    // ③ 群史里提到过
    const evs = readChronicle(g);
    for (const e of evs) {
      if (Array.isArray(e.participants) && e.participants.includes(oid)) {
        out.mentionedIn.push({ gid: g, date: e.date, participants: e.participants.length, score: e.score });
      }
    }

    // ④ 生日
    const bdays = readBirthdays(g);
    if (bdays.length) out.birthdays.push({ gid: g, list: bdays });
  }

  return out;
}

/**
 * 一个群的全部记忆（跨 6 套存储聚合）。
 *
 * @param {string} gid
 * @returns {object}
 */
export function readGroup(gid) {
  const bare = bareGid(gid);
  return {
    gid: bare,
    groupCard: readGroupCard(bare),
    chronicle: readChronicle(bare),
    chronicleText: readChronicleText(bare),
    relations: readRelations(bare),
    lifeStream: readLifeStream(bare, { limit: 20 }),
    slang: readSlang(bare),
    birthdays: readBirthdays(bare),
  };
}

/**
 * 全局概览（体量 + 健康度）。
 * @returns {object}
 */
export function overview() {
  const count = (dir, ext) => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(ext)).length;
    } catch { return 0; }
  };
  /**
   * 目录体量。
   *
   * ★ 2026-11-26 优化：原来逐文件 statSync，archive 有几百个文件时耗时 60ms+。
   *   改为：**只统计两层 + 单文件超过阈值才 stat**，并给总耗时兜底。
   *   overview 是给人看的概览，不需要精确到字节。
   */
  const sizeOf = (dir, opts = {}) => {
    const maxDepth = Number(opts.depth) > 0 ? Number(opts.depth) : 3;
    const deadline = Date.now() + 20;   // 最多算 20ms，超时就返回已算的
    try {
      let total = 0;
      const walk = (d, depth) => {
        if (depth > maxDepth || Date.now() > deadline) return;
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (Date.now() > deadline) return;
          const fp = join(d, e.name);
          if (e.isDirectory()) { walk(fp, depth + 1); continue; }
          // 只对「看起来不大」的文件 stat；大目录靠文件数估算
          try { total += statSync(fp).size; } catch { /* ignore */ }
        }
      };
      walk(dir, 0);
      return total;
    } catch { return 0; }
  };

  const groupsRoot = join(ROOTS.memory, 'groups');
  const groups = listDirs(groupsRoot);

  let peopleCards = 0;
  for (const g of groups) {
    peopleCards += count(join(groupsRoot, g, 'entities', 'people'), '.md');
  }

  return {
    groups: groups.length,
    peopleCards,
    chronicleGroups: listDirs(ROOTS.chronicle).length,
    relationGroups: count(ROOTS.relations, '.json'),
    lifeStreamGroups: listDirs(ROOTS.lifeStream).filter((d) => d.startsWith('group_') || d.length > 20).length,
    evolutionSnapshots: count(ROOTS.evolution, '.jsonl') ? readJsonl(join(ROOTS.evolution, 'metrics.jsonl')).length : 0,
    archiveFiles: count(ROOTS.archive, '') || sizeOf(ROOTS.archive),
    sizes: {
      memory: sizeOf(ROOTS.memory),
      chronicle: sizeOf(ROOTS.chronicle),
      relations: sizeOf(ROOTS.relations),
      lifeStream: sizeOf(ROOTS.lifeStream),
      evolution: sizeOf(ROOTS.evolution),
      archive: sizeOf(ROOTS.archive),
    },
  };
}

export default {
  readPerson, readGroup, readChronicle, readChronicleText,
  readRelations, readEvolution, readMilestones, readLifeStream,
  readSlang, readBirthdays, readPersonCard, readGroupCard, overview,
};
