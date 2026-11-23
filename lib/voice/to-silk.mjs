/**
 * voice/to-silk — WAV → SILK 转码（2026-11-18）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要转码：
 *   QQ 语音消息只吃 SILK（腾讯自研语音编码）。
 *   WAV 直接发会被当成"文件"，不是"语音气泡"。
 *
 * ── 实测数据（2026-11-18）──────────────────────────────────────────────────
 *   爱莉 TTS 输出 24000Hz 16bit 单声道 WAV = 96,448 bytes（2 秒）
 *   → silk-wasm 编码 = 8,326 bytes
 *   压缩比 11.6:1，QQ 完全吃得下
 *
 * ── 依赖 ───────────────────────────────────────────────────────────────────
 *   silk-wasm 已在本机：~/.dsh/profiles/web/node_modules/silk-wasm
 *   优先 mjs 入口，回退 cjs（不同版本导出方式不同）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadPackage } from '../pure/deps.mjs';

let _silk = null;

/**
 * 懒加载 silk-wasm（单例缓存）。
 *
 * ★ 2026-11-20 换可移植解析：以前写死 `~/.dsh/profiles/web/node_modules/`
 *   ⇒ 别人 DSH 布局不同就静默不可用。现在走 lib/pure/deps.mjs 的四级查找
 *   （env → 包内 node_modules → 向上找 → profile 兜底），找不到会给出明确装法。
 *
 * @returns {Promise<object|null>}
 */
export async function loadSilk() {
  if (_silk) return _silk;
  const r = await loadPackage('silk-wasm', { envVar: 'BNN_SILK_WASM' });
  if (!r.ok) return null;
  const api = r.mod?.encode ? r.mod : (r.mod?.default ?? null);
  if (api && typeof api.encode === 'function') {
    _silk = api;
    return api;
  }
  return null;
}


/**
 * ★ 2026-11-19 修：重采样到 16kHz。
 *
 * 为什么必须做：
 *   CloneTTS 输出 24kHz WAV，而 QQ 语音标准是 16kHz。
 *   直接把 24k PCM 交给 silk-wasm，SILK 头会记录 24000，
 *   但 QQ 播放器按 16000 解码 ⇒ 播放速度变慢、音调变低、听起来卡。
 *
 * 算法：线性插值（够用，且无依赖）。
 *
 * @param {Buffer} pcm 16bit LE PCM
 * @param {number} from 源采样率
 * @param {number} to 目标采样率
 * @returns {Buffer}
 */
/**
 * ★ 2026-11-19 修：抗混叠低通滤波（FIR，Hamming 窗 sinc）。
 *
 * 为什么必须加：
 *   Voicebox 输出 32kHz，但实测频谱有 **8kHz 镜像**
 *   （4k+8k=12k、2k+8k=10k、6k+8k=14k，强度完全相同）。
 *   说明它内部是 16kHz 生成后简单上采样到 32kHz。
 *   直接线性插值降到 16kHz → 镜像折返到 <8kHz → 声音刺耳（"尖"）。
 *
 * 正确做法：降采样**之前**先低通滤到 Nyquist 以下（7.2kHz）。
 */
export function lowpassPcm(pcm, sr, cutoff) {
  const nIn = pcm.length / 2;
  if (nIn < 64) return pcm;

  const TAPS = 63;
  const fc = Math.min(cutoff / sr, 0.49);
  const center = (TAPS - 1) / 2;

  const h = new Float64Array(TAPS);
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - center;
    let v;
    if (n === 0) v = 2 * fc;
    else v = Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1));
    h[i] = v * w;
    sum += h[i];
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum || 1;

  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < nIn; i++) {
    let acc = 0;
    for (let k = 0; k < TAPS; k++) {
      const idx = i + k - center;
      if (idx < 0 || idx >= nIn) continue;
      acc += pcm.readInt16LE(idx * 2) * h[k];
    }
    const v = Math.round(acc);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

export function resamplePcm(pcm, from, to) {
  if (from === to) return pcm;
  const nIn = pcm.length / 2;
  const ratio = to / from;
  const nOut = Math.floor(nIn * ratio);
  const out = Buffer.alloc(nOut * 2);
  for (let i = 0; i < nOut; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = i0 < nIn ? pcm.readInt16LE(i0 * 2) : 0;
    const b = i0 + 1 < nIn ? pcm.readInt16LE((i0 + 1) * 2) : a;
    const v = Math.round(a + (b - a) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

/** QQ 语音标准采样率。 */
export const QQ_VOICE_SAMPLE_RATE = 16000;

/**
 * 解析 WAV 头，取 PCM 数据与参数。
 * @param {Buffer} buf
 * @returns {{ok:boolean, pcm?:Buffer, sampleRate?:number, channels?:number, bits?:number, reason?:string}}
 */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return { ok: false, reason: 'TOO_SHORT' };
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'NOT_WAV' };
  }

  let pos = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;

  while (pos < buf.length - 8) {
    const id = buf.toString('ascii', pos, pos + 4);
    const sz = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = sz;
      break;
    }
    pos += 8 + sz + (sz % 2);
  }

  if (!fmt || dataOff < 0) return { ok: false, reason: 'NO_DATA' };
  if (fmt.bits !== 16) return { ok: false, reason: 'NOT_16BIT', detail: fmt.bits + 'bit' };
  if (fmt.channels !== 1) return { ok: false, reason: 'NOT_MONO', detail: fmt.channels + 'ch' };

  const pcm = buf.subarray(dataOff, Math.min(dataOff + dataLen, buf.length));
  return { ok: true, pcm, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits };
}

/**
 * WAV Buffer → SILK Buffer。
 *
 * @param {Buffer} wavBuf
 * @returns {Promise<{ok:boolean, silk?:Buffer, durationSec?:number, reason?:string, detail?:string}>}
 */
export async function wavToSilk(wavBuf, opts = {}) {
  try {
    const parsed = parseWav(wavBuf);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: parsed.detail };

    const silk = await loadSilk();
    if (!silk) return { ok: false, reason: 'NO_SILK_LIB' };

    // ★ 2026-11-19：重采样统一到 QQ 标准 16kHz。
    //
    // 历史教训（这条别改回去）：
    //   · 13 号那天试过「保持原采样率」，结果 32kHz 的 SILK 在 QQ 里播放异常
    //   · QQ 语音消息的标准就是 16kHz 单声道 SILK
    //   · Voicebox 输出 32kHz，CloneTTS 输出 24kHz，都要重采样
    // ★ 先抗混叠低通（截止 7.2kHz），再降采样到 16k
    //   不做这步：32k 里的镜像会折返，声音刺耳
    // ★ cutoff <= 0 → 不滤波，纯净转码（默认）
    const cutoff = Number(opts.antiAliasCutoff) > 0 ? Number(opts.antiAliasCutoff) : 0;
    const needsFilter = cutoff > 0 && parsed.sampleRate > QQ_VOICE_SAMPLE_RATE;
    const filtered = needsFilter
      ? lowpassPcm(parsed.pcm, parsed.sampleRate, cutoff)
      : parsed.pcm;
    const pcmOut = parsed.sampleRate === QQ_VOICE_SAMPLE_RATE
      ? parsed.pcm
      : resamplePcm(filtered, parsed.sampleRate, QQ_VOICE_SAMPLE_RATE);

    const out = await silk.encode(pcmOut, QQ_VOICE_SAMPLE_RATE);
    const data = out?.data ?? out?.silk ?? null;
    if (!data) return { ok: false, reason: 'ENCODE_EMPTY' };

    const silkBuf = Buffer.from(data);
    if (silkBuf.length < 100) return { ok: false, reason: 'TOO_SMALL', detail: silkBuf.length + ' bytes' };

    // 时长按重采样后的算
    const durationSec = pcmOut.length / (QQ_VOICE_SAMPLE_RATE * 2);

    return { ok: true, silk: silkBuf, durationSec };
  } catch (e) {
    return { ok: false, reason: 'EXCEPTION', detail: e instanceof Error ? e.message : String(e) };
  }
}