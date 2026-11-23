/**
 * song/decode — 本地音频解码（2026-11-19 R5.2）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 目标：任意音频 → **16kHz 单声道 s16le PCM**
 *
 * ── 解码器选择（实测对比）──────────────────────────────────────────────────
 *
 *   ① **mpg123-decoder（纯 JS + WASM）** ✅ 采用
 *      · 实测：4.6MB MP3（5 分钟）→ 757ms 解完
 *      · 纯 JS，零系统依赖，不会被 apt/网络卡住
 *      · 只支持 MP3 —— 但曲库 133 首全是 MP3
 *
 *   ② ffmpeg（Termux apt 装）
 *      · 通吃所有格式
 *      · 但依赖链 50+ 包、含 libllvm 30.7MB，实测 12KB/s 下不完
 *      · 作为**可选后备**：装了就用，没装就跳过
 *
 * ── 处理链 ─────────────────────────────────────────────────────────────────
 *
 *   MP3 → mpg123 解码（44.1k 双声道 Float32）
 *       → 取中段 30 秒（避开前奏）
 *       → 下混单声道
 *       → 重采样 16k
 *       → Int16 PCM
 *
 * ── 工业纪律 ───────────────────────────────────────────────────────────────
 *   解码失败有结构化原因；超时保护；绝不抛。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { EXT_ROOT } from '../pack-paths.mjs';

/** 目标采样率。 */
export const TARGET_RATE = 16000;

/** QQ 语音上限（秒）。 */
export const QQ_VOICE_MAX_SEC = 60;

/** 实际裁剪时长（秒）。 */
export const CLIP_SEC = 30;

/** 起点比例（避开前奏）。 */
const START_RATIO = 0.2;

// ── 懒加载解码器 ─────────────────────────────────────────────────────────────

let mp3Mod = null;
let mp3Tried = false;

/** 加载 mpg123-decoder。 */
async function loadMp3Decoder() {
  if (mp3Tried) return mp3Mod;
  mp3Tried = true;
  const candidates = [
    `${EXT_ROOT}/lib/song/vendor/mp3dec/mpg123-decoder/index.js`,
  ];
  for (const p of candidates) {
    try {
      const m = await import('file://' + p);
      if (m?.MPEGDecoder) { mp3Mod = m.MPEGDecoder; return mp3Mod; }
    } catch { /* 下一个 */ }
  }
  return null;
}

// ── 数字信号处理 ─────────────────────────────────────────────────────────────

/**
 * 多声道下混成单声道。
 *
 * @param {Float32Array[]} chans
 * @returns {Float32Array}
 */
export function downmix(chans) {
  if (!Array.isArray(chans) || chans.length === 0) return new Float32Array(0);
  if (chans.length === 1) return chans[0];
  const n = chans[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const c of chans) v += c[i] || 0;
    out[i] = v / chans.length;
  }
  return out;
}

/**
 * 线性插值重采样。
 *
 * @param {Float32Array} src
 * @param {number} from
 * @param {number} to
 * @returns {Float32Array}
 */
export function resampleFloat(src, from, to) {
  if (from === to) return src;
  const ratio = to / from;
  const nOut = Math.floor(src.length * ratio);
  const out = new Float32Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = i0 < src.length ? src[i0] : 0;
    const b = i0 + 1 < src.length ? src[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Float32 [-1,1] → Int16 PCM Buffer。
 *
 * @param {Float32Array} f32
 * @returns {Buffer}
 */
export function floatToInt16(f32) {
  const buf = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

// ── MP3 解码 ────────────────────────────────────────────────────────────────

/**
 * MP3 → 16k 单声道 PCM（裁剪 30 秒）。
 *
 * @param {string} filePath
 * @param {{clipSec?:number, startRatio?:number}} [opts]
 * @returns {Promise<{ok:boolean, pcm?:Buffer, durationSec?:number, startSec?:number, srcRate?:number, reason?:string, detail?:string}>}
 */
export async function mp3ToPcm16k(filePath, opts = {}) {
  const Decoder = await loadMp3Decoder();
  if (!Decoder) return { ok: false, reason: 'NO_MP3_DECODER' };

  let raw;
  try {
    const { readFileSync } = await import('node:fs');
    raw = new Uint8Array(readFileSync(filePath));
  } catch (e) {
    return { ok: false, reason: 'READ_FAIL', detail: e instanceof Error ? e.message : String(e) };
  }
  if (raw.length < 1000) return { ok: false, reason: 'FILE_TOO_SMALL' };

  let decoded;
  const dec = new Decoder();
  try {
    await dec.ready;
    decoded = dec.decode(raw);
  } catch (e) {
    try { dec.free(); } catch { /* ignore */ }
    return { ok: false, reason: 'DECODE_FAIL', detail: e instanceof Error ? e.message : String(e) };
  }
  try { dec.free(); } catch { /* ignore */ }

  const chans = decoded?.channelData;
  const srcRate = Number(decoded?.sampleRate) || 44100;
  if (!Array.isArray(chans) || !chans.length || !chans[0]?.length) {
    return { ok: false, reason: 'DECODE_EMPTY' };
  }

  const totalSec = chans[0].length / srcRate;
  const clipSec = Number(opts.clipSec) > 0 ? Number(opts.clipSec) : CLIP_SEC;
  const ratio = Number.isFinite(opts.startRatio) ? Number(opts.startRatio) : START_RATIO;

  // 起点：长歌取 20%，短歌从头
  const startSec = totalSec > clipSec * 2 ? totalSec * ratio : 0;
  const startSample = Math.floor(startSec * srcRate);
  const takeSamples = Math.min(
    Math.floor(clipSec * srcRate),
    chans[0].length - startSample,
  );
  if (takeSamples <= 0) return { ok: false, reason: 'EMPTY_SLICE' };

  // 切片（每个声道）
  const sliced = chans.map((c) => c.subarray(startSample, startSample + takeSamples));

  // 下混 + 重采样 + Int16
  const mono = downmix(sliced);
  const resampled = resampleFloat(mono, srcRate, TARGET_RATE);
  let pcm = floatToInt16(resampled);

  // 硬限制 60 秒
  const maxBytes = QQ_VOICE_MAX_SEC * TARGET_RATE * 2;
  if (pcm.length > maxBytes) pcm = pcm.subarray(0, maxBytes);

  return {
    ok: true,
    pcm,
    durationSec: pcm.length / (TARGET_RATE * 2),
    startSec: Math.round(startSec * 100) / 100,
    srcRate,
    totalSec: Math.round(totalSec * 100) / 100,
  };
}

// ── ffmpeg 后备（可选）──────────────────────────────────────────────────────

/** ffmpeg 是否可用（装了才用）。 */
let ffChecked = null;
export async function isFfmpegAvailable() {
  if (ffChecked !== null) return ffChecked;
  ffChecked = await new Promise((resolve) => {
    let child;
    try {
      child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch { return resolve(false); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(false); }, 8000);
    timer.unref?.();
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  return ffChecked;
}

/**
 * ffmpeg 解码任意格式（后备）。
 *
 * @param {string} filePath
 * @param {{clipSec?:number, startSec?:number, timeoutMs?:number}} [opts]
 */
export async function ffmpegToPcm16k(filePath, opts = {}) {
  const clipSec = Number(opts.clipSec) > 0 ? Number(opts.clipSec) : CLIP_SEC;
  const startSec = Number(opts.startSec) >= 0 ? Number(opts.startSec) : 20;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ffmpeg', [
        '-v', 'error', '-nostdin',
        '-ss', String(startSec),
        '-t', String(clipSec),
        '-i', filePath,
        '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(TARGET_RATE),
        '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, reason: 'FFMPEG_MISSING', detail: e instanceof Error ? e.message : String(e) });
    }

    const chunks = [];
    let stderr = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      done({ ok: false, reason: 'FFMPEG_TIMEOUT' });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      done({ ok: false, reason: /ENOENT/.test(msg) ? 'FFMPEG_MISSING' : 'FFMPEG_SPAWN_FAIL', detail: msg });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return done({ ok: false, reason: 'FFMPEG_FAIL', detail: stderr.slice(0, 200) });
      const pcm = Buffer.concat(chunks);
      if (pcm.length < 1000) return done({ ok: false, reason: 'PCM_TOO_SMALL' });
      done({ ok: true, pcm, durationSec: pcm.length / (TARGET_RATE * 2), startSec, totalSec: 0, srcRate: TARGET_RATE });
    });
  });
}

/**
 * 统一入口：按扩展名选解码器。
 *
 * @param {string} filePath
 * @param {{clipSec?:number}} [opts]
 */
export async function audioToPcm16k(filePath, opts = {}) {
  const path = String(filePath ?? '').trim();
  if (!path) return { ok: false, reason: 'EMPTY_PATH' };
  if (!existsSync(path)) return { ok: false, reason: 'FILE_NOT_FOUND', detail: path };

  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

  // MP3 → 首选纯 JS 解码器
  if (ext === 'mp3' || ext === '') {
    const r = await mp3ToPcm16k(path, opts);
    if (r.ok) return r;
    // 解码器不可用 → 试 ffmpeg
    if (r.reason === 'NO_MP3_DECODER' && await isFfmpegAvailable()) {
      return await ffmpegToPcm16k(path, opts);
    }
    return r;
  }

  // 其他格式 → ffmpeg
  if (await isFfmpegAvailable()) return await ffmpegToPcm16k(path, opts);

  return { ok: false, reason: 'NO_DECODER_FOR_' + (ext || 'UNKNOWN').toUpperCase(), detail: '需要 ffmpeg' };
}
