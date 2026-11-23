/**
 * voice/clone-tts — 语音合成 HTTP 客户端（2026-11-19 改用 Voicebox）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 支持两个引擎（配置切换）：
 *
 * ① Voicebox（默认，port 16580）
 *      POST /infer
 *      { modelId, language, text, referenceAudioPath, referenceText }
 *      → WAV 32kHz 单声道
 *
 * ② CloneTTS（兼容保留，port 8080）
 *      GET /api/tts?text=&voice=
 *      → WAV 24kHz 单声道
 *
 * ── 为什么换 Voicebox 的实测依据 ──────────────────────────────────────────
 *   · CloneTTS 的 speed 参数有 bug：传了语速慢一倍（0.95s → 1.86s）
 *   · Voicebox 可直接导入 GPT-SoVITS 专训权重（爱莉模型已训练好）
 *   · 性能：RTF 0.62-0.78（CPU 模式，官方标称 GPU 0.51）
 *
 * ── 失败处理 ───────────────────────────────────────────────────────────────
 *   所有异常返回 { ok:false, reason, detail }，**绝不抛**。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { DEFAULT_VOICE_CONFIG } from './config.mjs';

/**
 * 健康检查 / 取模型列表。
 * @param {object} cfg
 * @returns {Promise<{ok:boolean, models?:Array, reason?:string}>}
 */
export async function listModels(cfg) {
  const c = cfg ?? DEFAULT_VOICE_CONFIG;
  try {
    const r = await fetch(`${c.apiBase}/models`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, reason: 'HTTP_' + r.status };
    const j = await r.json();
    if (!j?.ok || !Array.isArray(j.models)) return { ok: false, reason: 'BAD_JSON' };
    return { ok: true, models: j.models };
  } catch (e) {
    return { ok: false, reason: 'NETWORK', detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 旧接口兼容：克隆/音色列表（CloneTTS 用）。
 * @param {object} cfg
 */
export async function listVoices(cfg) {
  const c = cfg ?? DEFAULT_VOICE_CONFIG;
  if (c.engine !== 'clonetts') return listModels(cfg);
  try {
    const r = await fetch(`${c.apiBase}/api/voices`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, reason: 'HTTP_' + r.status };
    const arr = await r.json();
    if (!Array.isArray(arr)) return { ok: false, reason: 'BAD_JSON' };
    return { ok: true, voices: arr };
  } catch (e) {
    return { ok: false, reason: 'NETWORK', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 校验返回的是不是真 WAV。 */
function isWavBuf(buf) {
  return buf.length > 44
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WAVE';
}

/**
 * 合成语音，返回 WAV 字节。
 *
 * @param {string} text
 * @param {object} cfg
 * @param {{voice?:string, speed?:number}} [opts]
 * @returns {Promise<{ok:boolean, wav?:Buffer, reason?:string, detail?:string, elapsedMs?:number}>}
 */
export async function synthesize(text, cfg, opts = {}) {
  const c = cfg ?? DEFAULT_VOICE_CONFIG;
  const t = String(text ?? '').trim();

  if (!t) return { ok: false, reason: 'EMPTY_TEXT' };
  if ([...t].length > c.maxTextChars) {
    return { ok: false, reason: 'TOO_LONG', detail: `${[...t].length} > ${c.maxTextChars}` };
  }

  const started = Date.now();

  // ── Voicebox 模式 ──
  if (c.engine === 'voicebox') {
    const body = {
      modelId: c.modelId,
      language: c.language || 'zh',
      text: t,
      referenceAudioPath: c.referenceAudioPath,
      referenceText: c.referenceText,
      // ★ 显式传生成参数（App UI 配置不会同步到 API）
      ...(c.genParams && typeof c.genParams === 'object' ? c.genParams : {}),
    };
    try {
      const r = await fetch(`${c.apiBase}/infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(c.timeoutMs),
      });
      const buf = Buffer.from(await r.arrayBuffer());

      // Voicebox 失败时返回 JSON {ok:false,error,errorCode}
      if (buf.length > 0 && buf[0] === 0x7b) {   // '{'
        let j = null;
        try { j = JSON.parse(buf.toString('utf8')); } catch { /* ignore */ }
        const err = j?.error || j?.errorCode || buf.toString('utf8').slice(0, 120);
        return { ok: false, reason: 'ENGINE_' + (j?.errorCode || 'ERROR'), detail: String(err), elapsedMs: Date.now() - started };
      }

      if (!r.ok) return { ok: false, reason: 'HTTP_' + r.status, elapsedMs: Date.now() - started };
      if (!isWavBuf(buf)) return { ok: false, reason: 'NOT_WAV', detail: `${buf.length} bytes`, elapsedMs: Date.now() - started };

      return { ok: true, wav: buf, elapsedMs: Date.now() - started };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const reason = /timeout|abort/i.test(msg) ? 'TIMEOUT' : 'NETWORK';
      return { ok: false, reason, detail: msg, elapsedMs: Date.now() - started };
    }
  }

  // ── CloneTTS 模式（兼容保留）──
  const voice = String(opts.voice ?? c.defaultVoice ?? '').trim();
  if (!voice) return { ok: false, reason: 'NO_VOICE' };

  // ★ 不要传 speed（CloneTTS bug：传了就慢一倍）
  const url = `${c.apiBase}/api/tts`
    + `?text=${encodeURIComponent(t)}`
    + `&voice=${encodeURIComponent(voice)}`;

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(c.timeoutMs) });
    if (!r.ok) {
      const b = await r.text().catch(() => '');
      return { ok: false, reason: 'HTTP_' + r.status, detail: b.slice(0, 200) };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!isWavBuf(buf)) return { ok: false, reason: 'NOT_WAV', detail: `${buf.length} bytes` };
    return { ok: true, wav: buf, elapsedMs: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const reason = /timeout|abort/i.test(msg) ? 'TIMEOUT' : 'NETWORK';
    return { ok: false, reason, detail: msg, elapsedMs: Date.now() - started };
  }
}

/**
 * 健康检查。
 * @param {object} cfg
 * @returns {Promise<boolean>}
 */
export async function isOnline(cfg) {
  const c = cfg ?? DEFAULT_VOICE_CONFIG;
  try {
    const r = await fetch(`${c.apiBase}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.ok === true;
  } catch {
    return false;
  }
}