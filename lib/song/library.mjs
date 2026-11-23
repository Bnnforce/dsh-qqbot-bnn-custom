/**
 * song/library — 本地曲库扫描与索引（2026-11-19 R5.2）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 曲库位置：{WORKSPACE_ROOT}/Bot/曲库/（可用 BNN_SONG_DIR 覆盖）
 * 文件命名：`歌名 - 歌手.mp3`
 *
 * ── 设计要点 ───────────────────────────────────────────────────────────────
 *
 *   ① **拍平**：不分 Jaymp3/崩坏mp3/瓦mp3，全库一个列表
 *   ② **特殊曲加权**：爱莉希雅原创曲出现概率 ×3（主人要求"特殊对待"）
 *   ③ **60 秒 TTL**：曲库改动最多 1 分钟后生效，不用重启
 *   ④ **纯函数友好**：解析/随机/搜索都可单测，不依赖运行时
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { DATA_ROOT, WORKSPACE_ROOT } from '../pack-paths.mjs';
import { SONG_ROOT } from '../dirs.mjs';

/** 曲库根目录。 */
export const LIBRARY_ROOT = SONG_ROOT;

/** 支持的音频扩展名（ffmpeg 都能解）。 */
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma', '.ape']);

/** 特殊曲关键词（含这些 → special，随机时加权）。 */
const SPECIAL_KEYWORDS = ['爱莉希雅', '爱莉', 'Elysia', 'elysia'];

/** 索引缓存 TTL（毫秒）。 */
const CACHE_TTL_MS = 60_000;

/** 模块级缓存。 */
let cache = null;

/**
 * 解析文件名 → { title, artist }。
 *
 * 规则：`歌名 - 歌手.mp3`
 *   · ` - ` 第一个出现处分割
 *   · 没有 ` - ` → 整个文件名当歌名，artist 为空
 *
 * @param {string} filePath
 * @returns {{title:string, artist:string}}
 */
export function parseFileName(filePath) {
  const base = basename(String(filePath ?? ''), extname(String(filePath ?? '')));
  const name = base.trim();
  if (!name) return { title: '', artist: '' };

  const idx = name.indexOf(' - ');
  if (idx > 0) {
    return {
      title: name.slice(0, idx).trim(),
      artist: name.slice(idx + 3).trim(),
    };
  }
  return { title: name, artist: '' };
}

/**
 * 判断是否特殊曲（爱莉希雅相关）。
 *
 * @param {string} title
 * @param {string} artist
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSpecial(title, artist, filePath) {
  const hay = `${title} ${artist} ${filePath}`.toLowerCase();
  return SPECIAL_KEYWORDS.some((k) => hay.includes(k.toLowerCase()));
}

/**
 * 递归扫描曲库目录，返回曲目列表。
 *
 * @param {string} [root]
 * @returns {Array<{file:string, title:string, artist:string, dir:string, ext:string, size:number, special:boolean}>}
 */
export function scanLibrary(root = LIBRARY_ROOT) {
  const out = [];
  if (!existsSync(root)) return out;

  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, depth + 1); continue; }
      if (!ent.isFile()) continue;

      const ext = extname(ent.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;

      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size < 100 * 1024) continue;      // 小于 100KB 视为损坏/占位

      const { title, artist } = parseFileName(full);
      out.push({
        file: full,
        title,
        artist,
        dir: basename(dir),
        ext,
        size,
        special: isSpecial(title, artist, full),
      });
    }
  };

  walk(root, 0);
  // 稳定排序：先特殊曲，再按标题
  out.sort((a, b) => (b.special - a.special) || a.title.localeCompare(b.title, 'zh'));
  return out;
}

/**
 * 取曲库（带 60 秒缓存）。
 *
 * @param {{force?:boolean, root?:string}} [opts]
 */
export function getLibrary(opts = {}) {
  const root = opts.root || LIBRARY_ROOT;
  const now = Date.now();
  if (!opts.force && cache && cache.root === root && now - cache.at < CACHE_TTL_MS) {
    return cache.songs;
  }
  const songs = scanLibrary(root);
  cache = { at: now, root, songs };
  return songs;
}

/** 手动清缓存（测试用）。 */
export function clearCache() {
  cache = null;
}

/**
 * 随机选一首。
 *
 * ★ 特殊曲加权：爱莉希雅相关曲目入池 3 次，普通曲 1 次。
 *
 * @param {Array} songs
 * @param {() => number} [random]
 * @returns {object|null}
 */
export function pickRandom(songs, random = Math.random) {
  if (!Array.isArray(songs) || songs.length === 0) return null;
  const pool = [];
  for (const s of songs) {
    pool.push(s);
    if (s.special) { pool.push(s); pool.push(s); }
  }
  return pool[Math.floor(random() * pool.length)] ?? null;
}

/**
 * 关键词搜索（歌名 / 歌手 / 文件名子串）。
 *
 * @param {Array} songs
 * @param {string} keyword
 * @returns {Array}
 */
export function searchLibrary(songs, keyword) {
  const q = String(keyword ?? '').trim().toLowerCase();
  if (!q) return [];
  return (songs || []).filter((s) => {
    const hay = `${s.title} ${s.artist} ${basename(s.file)}`.toLowerCase();
    return hay.includes(q);
  });
}

/**
 * 曲库统计（给卡片文案用）。
 *
 * @param {Array} songs
 */
export function statsOf(songs) {
  const arr = Array.isArray(songs) ? songs : [];
  return {
    total: arr.length,
    special: arr.filter((s) => s.special).length,
  };
}
