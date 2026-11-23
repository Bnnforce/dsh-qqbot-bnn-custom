/**
 * wake-lottery/atlas — 图鉴（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它是什么
 *   记录「某个用户在某个群里，中过哪些奖项」。
 *
 * 三条硬纪律
 *   ① **只按哈希存**：不存 openid 明文（开源上架隐私要求）。
 *   ② **不跨群聚合**：图鉴是「本群的你」，不是「全网通的你」。
 *      换群 = 一本新图鉴。这样即使哈希相同也无法跨群反推。
 *   ③ **读不到就空**：文件缺失/损坏 → 返回空图鉴，绝不抛。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { PRIZE_KEYS, RARITY_OF, DEFAULT_CONFIG } from './config.mjs';
import { atlasFile, readJsonSafe, writeJsonAtomic, hashOpenid } from './store.mjs';

/* ──────────────────────────────────────────────────────────────
 * 稀有度展示
 * ────────────────────────────────────────────────────────────── */

/** 稀有度 → 显示标记。 */
const RARITY_MARK = Object.freeze({
  common: '',
  uncommon: '·',
  rare: '★',
  legendary: '✦',
});

/** 稀有度 → 中文名。 */
const RARITY_LABEL = Object.freeze({
  common: '普通', uncommon: '少见', rare: '稀少', legendary: '极稀',
});

/** 奖项 key → 中文名（展示用）。 */
export const PRIZE_LABEL = Object.freeze({
  quote: '一句话',
  image: '一张图',
  points: '积分',
  sticker: '表情包',
  voice: '一段语音',
  song: '一首歌',
  nickname: '专属称呼',
  multiplier: '加倍券',
  secret: '隐藏款',
});

/* ──────────────────────────────────────────────────────────────
 * 读 / 写
 * ────────────────────────────────────────────────────────────── */

/** 空图鉴。 */
export function emptyAtlas() {
  return { collected: [], counts: {}, firstAt: {} };
}

/**
 * 读某用户在某群的图鉴。
 *
 * @param {string} gid
 * @param {string} openidHash
 * @returns {{collected:string[], counts:Record<string,number>, firstAt:Record<string,number>}}
 */
export function readAtlas(gid, openidHash) {
  const hash = String(openidHash ?? '').trim();
  if (!hash) return emptyAtlas();

  const raw = readJsonSafe(atlasFile(gid, hash));
  if (!raw) return emptyAtlas();

  const collected = [];
  const counts = {};
  const firstAt = {};

  for (const key of PRIZE_KEYS) {
    const c = Number(raw.counts?.[key]);
    const safeCount = Number.isFinite(c) && c > 0 ? Math.round(c) : 0;
    if (safeCount > 0) {
      collected.push(key);
      counts[key] = safeCount;
      const f = Number(raw.firstAt?.[key]);
      if (Number.isFinite(f) && f > 0) firstAt[key] = f;
    }
  }

  return { collected, counts, firstAt };
}

/**
 * 记录一次抽奖。
 *
 * @param {string} gid
 * @param {string} openidHash
 * @param {string} prizeKey
 * @param {number} nowMs
 * @returns {{ok:boolean, isNew:boolean}}
 */
export function recordDraw(gid, openidHash, prizeKey, nowMs) {
  const g = String(gid ?? '').trim();
  const hash = String(openidHash ?? '').trim();
  const key = String(prizeKey ?? '').trim();
  // ⚠️ gid 为空必须拒绝：
  //    否则会写进 'unknown' 群，造成跨群污染（隐私红线 R38）。
  if (!g || !hash || !PRIZE_KEYS.includes(key)) return { ok: false, isNew: false };

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const atlas = readAtlas(gid, hash);
  const isNew = !atlas.collected.includes(key);

  atlas.counts[key] = (atlas.counts[key] || 0) + 1;
  if (isNew) {
    atlas.collected.push(key);
    atlas.firstAt[key] = now;
  }

  const ok = writeJsonAtomic(atlasFile(gid, hash), {
    collected: atlas.collected,
    counts: atlas.counts,
    firstAt: atlas.firstAt,
    updatedAt: now,
  });

  return { ok, isNew };
}

/* ──────────────────────────────────────────────────────────────
 * 展示
 * ────────────────────────────────────────────────────────────── */

/**
 * 生成图鉴摘要（给 /抽奖图鉴 命令用）。
 *
 * @param {string} gid
 * @param {string} openidHash
 * @param {object} [cfg]
 * @returns {{collected:string[], total:number, text:string}}
 */
export function atlasSummary(gid, openidHash, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const atlas = readAtlas(gid, openidHash);
  const total = PRIZE_KEYS.length;

  if (atlas.collected.length === 0) {
    return { collected: [], total, text: `还没抽到过东西。\n\n（共 ${total} 种，集齐会有惊喜）` };
  }

  // 按稀有度排序展示
  const order = { legendary: 0, rare: 1, uncommon: 2, common: 3 };
  const sorted = [...atlas.collected].sort((a, b) => {
    const ra = order[RARITY_OF[a]] ?? 9;
    const rb = order[RARITY_OF[b]] ?? 9;
    return ra - rb;
  });

  const lines = sorted.map((key) => {
    const mark = RARITY_MARK[RARITY_OF[key]] || '·';
    const label = PRIZE_LABEL[key] || key;
    const count = atlas.counts[key] || 1;
    const suffix = count > 1 ? ` ×${count}` : '';
    return `${mark} ${label}${suffix}`;
  });

  const missing = PRIZE_KEYS.filter((k) => !atlas.collected.includes(k));
  const head = `## 抽奖图鉴\n\n**${atlas.collected.length} / ${total}** 种\n`;
  const body = lines.join('\n');
  const tail = missing.length
    ? `\n\n还没抽到：${missing.map((k) => PRIZE_LABEL[k] || k).join('、')}`
    : '\n\n**全部集齐了。**';

  return {
    collected: atlas.collected,
    total,
    text: `${head}\n${body}${tail}`,
  };
}

/** 稀有度说明（图鉴页脚用）。 */
export function rarityLegend() {
  return '✦ 极稀 / ★ 稀少 / · 少见 / 无标记 普通';
}

export default {
  PRIZE_LABEL, emptyAtlas, readAtlas, recordDraw, atlasSummary, rarityLegend,
};
