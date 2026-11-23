/**
 * prizes/voice — 一段语音（R5.6）
 *
 * 用现有 lib/voice 的 speak() 合成。**可选依赖**：TTS 不可用就返回 ok:false，
 * 上层换奖 —— 绝不卡住流程。
 *
 * ⚠️ 超时是硬要求：官方契约要求扩展不能阻塞主链。这里 8 秒超时。
 */
import { join } from 'node:path';
import { EXT_ROOT } from '../../pack-paths.mjs';
import { PERSONA_ROOT } from '../../dirs.mjs';
import { existsSync, readFileSync } from 'node:fs';

/** 播报内容（可按稀有度区分）。 */
const LINES = Object.freeze([
  '……抽到一段。',
  '来，听我说一句。',
  '这个给你，收好了。',
]);

/** 读语音配置（读不到返回 null）。 */
function readVoiceConfig() {
  try {
    const file = join(PERSONA_ROOT, '语音配置.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 懒加载 voice 模块。 */
async function voiceMod() {
  return import(join(EXT_ROOT, 'lib', 'voice', 'index.mjs') + `?wl=${Date.now()}`);
}

/**
 * 是否可用：**两个条件都满足**才算可用。
 *
 *   ① voice 模块能导入且有 speak
 *   ② 语音配置文件真实存在
 *
 * ⚠️ 只判 ① 是错的：模块永远能导入，但没配置就跑不出声音。
 *    这会让 availableOutlets() 误报可用 → 抽中 voice → 兑现失败 → 换奖，
 *    等于把「架构上避免失败」退化回「抽到再换」。必须在探测阶段就判准。
 */
export async function available() {
  try {
    const m = await voiceMod();
    if (typeof m?.speak !== 'function') return false;
    // ② 配置必须真实存在
    return readVoiceConfig() !== null;
  } catch {
    return false;
  }
}

/** 带超时的 Promise 包装。 */
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
 * 合成一段语音。
 *
 * @param {{random?:()=>number, timeoutMs?:number}} ctx
 */
export async function run(ctx) {
  try {
    const m = await voiceMod();
    if (typeof m?.speak !== 'function') return { ok: false, reason: 'voice-unavailable' };

    const cfg = readVoiceConfig();
    if (!cfg) return { ok: false, reason: 'voice-no-config' };

    const rnd = typeof ctx?.random === 'function' ? ctx.random : Math.random;
    const text = LINES[Math.min(LINES.length - 1, Math.max(0, Math.floor(rnd() * LINES.length)))];
    const timeoutMs = Number.isFinite(Number(ctx?.timeoutMs)) ? Number(ctx.timeoutMs) : 8000;

    const r = await withTimeout(m.speak(text, cfg), timeoutMs, 'voice');
    if (!r || r.ok === false) return { ok: false, reason: 'voice-synth-failed' };

    return {
      ok: true,
      payload: { kind: 'voice', content: { text, result: r } },
    };
  } catch (e) {
    return { ok: false, reason: `voice-error:${e instanceof Error ? e.message : String(e)}` };
  }
}

export default { available, run };
