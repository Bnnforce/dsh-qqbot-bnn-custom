/**
 * song/index — 点歌编排（2026-11-19 R5.2 本地曲库版）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 链路：
 *   曲库文件 ──ffmpeg──> PCM 16k ──silk-wasm──> SILK ──> QQ 语音
 *
 * ── 缓存 ───────────────────────────────────────────────────────────────────
 *   Key = hash(文件绝对路径 + mtime + size)
 *   曲库文件一换，缓存自动失效。
 *   位置：Bot/人格/歌单缓存/
 *
 * ── 工业纪律 ───────────────────────────────────────────────────────────────
 *   每步失败有结构化原因；缓存命中 0ms；超时保护。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getLibrary, pickRandom, searchLibrary, statsOf, parseFileName, LIBRARY_ROOT } from './library.mjs';
import { audioToPcm16k, isFfmpegAvailable, CLIP_SEC } from './decode.mjs';
import { pcmToSilk } from './to-silk.mjs';
import { DATA_ROOT, WORKSPACE_ROOT } from '../pack-paths.mjs';
import { PLAYLIST_CACHE_ROOT } from '../dirs.mjs';

export {
  LIBRARY_ROOT,
  getLibrary,
  pickRandom,
  searchLibrary,
  statsOf,
  parseFileName,
  isFfmpegAvailable,
  CLIP_SEC,
};

/** 缓存目录。 */
export const CACHE_ROOT = PLAYLIST_CACHE_ROOT;

/** 缓存保留天数。 */
const CACHE_DAYS = 30;

/** FNV-1a 哈希。 */
function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 清理过期缓存。 */
export function pruneCache(days = CACHE_DAYS) {
  try {
    if (!existsSync(CACHE_ROOT)) return 0;
    const cutoff = Date.now() - days * 86400_000;
    let n = 0;
    for (const f of readdirSync(CACHE_ROOT)) {
      if (!f.endsWith('.silk')) continue;
      const p = join(CACHE_ROOT, f);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); n++; }
      } catch { /* ignore */ }
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 单曲 → SILK（带缓存）。
 *
 * @param {object} song library 里的条目
 * @param {{useCache?:boolean, durationSec?:number}} [opts]
 * @returns {Promise<{ok:boolean, silkPath?:string, durationSec?:number, cached?:boolean, elapsedMs?:number, reason?:string, detail?:string}>}
 */
export async function songToSilk(song, opts = {}) {
  const started = Date.now();
  const file = String(song?.file ?? '').trim();
  if (!file) return { ok: false, reason: 'EMPTY_FILE' };
  if (!existsSync(file)) return { ok: false, reason: 'FILE_NOT_FOUND', detail: file };

  // ── 缓存 key：路径 + mtime + size ──
  let st;
  try { st = statSync(file); } catch (e) {
    return { ok: false, reason: 'STAT_FAIL', detail: e instanceof Error ? e.message : String(e) };
  }
  const clip = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : CLIP_SEC;
  const key = hashKey(`${file}|${Math.round(st.mtimeMs)}|${st.size}|${clip}`);
  const silkPath = join(CACHE_ROOT, `${key}.silk`);

  const useCache = opts.useCache !== false;
  if (useCache && existsSync(silkPath)) {
    try {
      const cs = statSync(silkPath);
      return {
        ok: true, silkPath, cached: true,
        durationSec: Number(cs.size) / 6000,     // 粗估（≈6KB/秒）
        elapsedMs: Date.now() - started,
      };
    } catch { /* 继续转码 */ }
  }

  // ── 解码 ──
  const dec = await audioToPcm16k(file, { durationSec: clip });
  if (!dec.ok) {
    return { ok: false, reason: 'DECODE_' + dec.reason, detail: dec.detail, elapsedMs: Date.now() - started };
  }

  // ── 编码 ──
  const enc = await pcmToSilk(dec.pcm);
  if (!enc.ok) {
    return { ok: false, reason: 'ENCODE_' + enc.reason, detail: enc.detail, elapsedMs: Date.now() - started };
  }

  // ── 落盘 ──
  try {
    if (!existsSync(CACHE_ROOT)) mkdirSync(CACHE_ROOT, { recursive: true });
    writeFileSync(silkPath, enc.silk);
  } catch (e) {
    return { ok: false, reason: 'WRITE_FAIL', detail: e instanceof Error ? e.message : String(e), elapsedMs: Date.now() - started };
  }

  return {
    ok: true,
    silkPath,
    durationSec: enc.durationSec,
    cached: false,
    elapsedMs: Date.now() - started,
    startSec: dec.startSec,
  };
}

/**
 * 随机点一首（全库，特殊曲加权）。
 *
 * @param {{random?:Function, useCache?:boolean}} [opts]
 */
export async function pickAndConvert(opts = {}) {
  const started = Date.now();
  const songs = getLibrary();
  if (!songs.length) return { ok: false, reason: 'EMPTY_LIBRARY', detail: LIBRARY_ROOT };

  const song = pickRandom(songs, opts.random);
  if (!song) return { ok: false, reason: 'PICK_NULL' };

  const conv = await songToSilk(song, { useCache: opts.useCache });
  return {
    ...conv,
    song,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 按关键词点播。
 *
 * @param {string} keyword
 * @param {{useCache?:boolean}} [opts]
 */
export async function searchAndConvert(keyword, opts = {}) {
  const started = Date.now();
  const songs = getLibrary();
  if (!songs.length) return { ok: false, reason: 'EMPTY_LIBRARY', detail: LIBRARY_ROOT };

  const hits = searchLibrary(songs, keyword);
  if (!hits.length) return { ok: false, reason: 'NOT_FOUND', detail: String(keyword ?? '') };

  const song = hits[0];
  const conv = await songToSilk(song, { useCache: opts.useCache });
  return {
    ...conv,
    song,
    matches: hits.length,
    elapsedMs: Date.now() - started,
  };
}
