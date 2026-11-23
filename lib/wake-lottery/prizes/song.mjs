/**
 * prizes/song — 一首歌（R5.6）
 *
 * 用现有 lib/song 的 pickAndConvert()。**可选依赖**：曲库为空就 ok:false → 换奖。
 *
 * ⚠️ 合成 silk 很慢（解码 + 转码），给 20 秒超时；超时就换奖。
 */
import { join } from 'node:path';
import { EXT_ROOT } from '../../pack-paths.mjs';
import { SONG_ROOT, safeList } from '../../dirs.mjs';

/** 懒加载 song 模块。 */
async function songMod() {
  return import(join(EXT_ROOT, 'lib', 'song', 'index.mjs') + `?wl=${Date.now()}`);
}

/**
 * 是否可用：曲库有 mp3。
 */
export async function available() {
  try {
    // ① 曲库必须真实有 mp3（防误报）
    const n = scanSongCount();
    if (n === 0) return false;
    // ② 模块必须有 pickAndConvert
    const m = await songMod();
    return typeof m?.pickAndConvert === 'function';
  } catch {
    return false;
  }
}

/** 递归数曲库里的 mp3（最多看两层，够用且快）。 */
function scanSongCount() {
  try {
    let total = 0;
    for (const sub of safeList(SONG_ROOT, { filesOnly: false })) {
      const p = join(SONG_ROOT, sub);
      const files = safeList(p, { filesOnly: true, exts: ['mp3'] });
      total += files.length;
      if (total > 0) return total;
    }
    return total;
  } catch {
    return 0;
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
      if (typeof t?.unref === 'function') t.unref();
    }),
  ]);
}

/**
 * 抽一首歌。
 *
 * @param {{random?:()=>number, timeoutMs?:number}} ctx
 */
export async function run(ctx) {
  try {
    const m = await songMod();
    if (typeof m?.pickAndConvert !== 'function') return { ok: false, reason: 'song-unavailable' };

    const timeoutMs = Number.isFinite(Number(ctx?.timeoutMs)) ? Number(ctx.timeoutMs) : 20000;
    const r = await withTimeout(m.pickAndConvert({}), timeoutMs, 'song');

    if (!r || r.ok === false) return { ok: false, reason: r?.reason || 'song-failed' };

    return {
      ok: true,
      payload: { kind: 'song', content: { result: r, title: r?.title || '', artist: r?.artist || '' } },
    };
  } catch (e) {
    return { ok: false, reason: `song-error:${e instanceof Error ? e.message : String(e)}` };
  }
}

export default { available, run };
