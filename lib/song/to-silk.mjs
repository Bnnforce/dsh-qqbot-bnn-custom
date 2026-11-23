import { loadPackage } from '../pure/deps.mjs';
/**
 * song/to-silk — PCM → SILK（2026-11-19 R5.2）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 输入已经是 **16kHz 单声道 s16le PCM**（decode.mjs 的输出），
 * 所以这里不需要重采样、不需要滤波 —— 只做编码。
 *
 * ── 为什么 QQ 要 SILK ──────────────────────────────────────────────────────
 *   QQ 语音消息的唯一格式。`[MEDIA:voice|路径]` 传 .silk 文件，
 *   点一下就在聊天里播（60 秒上限）。
 *
 * ── 实测 ────────────────────────────────────────────────────────────────────
 *   30 秒 16k 单声道 PCM（960KB）→ SILK 约 110-140KB（压缩比 7-8:1）
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 懒加载 silk-wasm。
 *
 * ★ 2026-11-20 换可移植解析（与 voice/to-silk.mjs 同一套）：
 *   以前这里找 `${WORKSPACE_ROOT}/Bot/人格/node_modules/silk-wasm`
 *   —— 数据目录里塞 node_modules 纯属本机巧合，别人机器上必然不存在。
 *   现在走 lib/pure/deps.mjs 四级查找。
 *
 * @returns {Promise<object|null>}
 */

/** 懒加载单例缓存 + 只尝试一次的标记。 */
let silkMod = null;
let silkTried = false;

export async function loadSilk() {
  if (silkTried) return silkMod;
  silkTried = true;
  const r = await loadPackage('silk-wasm', { envVar: 'BNN_SILK_WASM' });
  if (r.ok) silkMod = r.mod?.encode ? r.mod : (r.mod?.default ?? r.mod);
  return silkMod;
}

/**
 * PCM(16k 单声道 s16le) → SILK。
 *
 * @param {Buffer} pcm
 * @returns {Promise<{ok:boolean, silk?:Buffer, durationSec?:number, reason?:string, detail?:string}>}
 */
export async function pcmToSilk(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 1000) {
    return { ok: false, reason: 'PCM_TOO_SMALL', detail: String(pcm?.length ?? 0) + ' bytes' };
  }

  const silk = await loadSilk();
  if (!silk) return { ok: false, reason: 'NO_SILK_LIB' };

  try {
    const enc = await silk.encode(pcm, 16000);
    const data = enc?.data ?? enc?.silk;
    if (!data) return { ok: false, reason: 'ENCODE_EMPTY' };

    const buf = Buffer.from(data);
    if (buf.length < 100) return { ok: false, reason: 'TOO_SMALL', detail: buf.length + ' bytes' };

    return { ok: true, silk: buf, durationSec: pcm.length / (16000 * 2) };
  } catch (e) {
    return { ok: false, reason: 'ENCODE_FAIL', detail: e instanceof Error ? e.message : String(e) };
  }
}
