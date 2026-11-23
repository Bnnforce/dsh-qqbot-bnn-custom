/**
 * voice/index — 语音合成门面（2026-11-19 改用 Voicebox）
 *
 * 对外只暴露 speak()：文字 → SILK 文件，供命令/出站扩展使用。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 完整链路（Voicebox 模式）：
 *   文字 ──cleanForTts──> 干净文本
 *        ──Voicebox /infer──> WAV（32kHz，爱莉专训模型）
 *        ──resample 16k──> PCM
 *        ──silk-wasm──> SILK（QQ 语音标准）
 *        ──落盘──> 缓存文件
 *        ──返回路径──> 调用方发 MEDIA:voice
 *
 * ── 参考音管理（★ 关键坑）──────────────────────────────────────────────────
 *   Voicebox 每次 /infer 都要 referenceAudioPath + referenceText。
 *   实测踩过的坑：
 *     ① 放 /data/data/<pkg>/cache/ → App 用完会删
 *     ② 放 /sdcard/Download/       → 分区存储拒绝（EACCES）
 *     ③ 放 /sdcard/Android/data/<pkg>/files/ → ✅ 正确
 *   所以本模块在首次合成前会自动把参考音部署到 (3)。
 *
 * ── 工业纪律 ───────────────────────────────────────────────────────────────
 *   · 每步都能失败，且失败原因可观测
 *   · 缓存命中不重复合成（省电、省时间）
 *   · 旧缓存自动清理（防膨胀）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';

import { DEFAULT_VOICE_CONFIG, mergeVoiceConfig, validateVoiceConfig } from './config.mjs';
import { listVoices, listModels, synthesize, isOnline } from './clone-tts.mjs';
import { wavToSilk, loadSilk } from './to-silk.mjs';
import { cleanForTts, isSpeakable } from './text-clean.mjs';
import { WORKSPACE_ROOT } from '../pack-paths.mjs';
import { PERSONA_ROOT, VOICE_SAMPLE_ROOT, safeList, dirAvailable, ensureDir } from '../dirs.mjs';

export {
  DEFAULT_VOICE_CONFIG,
  mergeVoiceConfig,
  validateVoiceConfig,
  listVoices,
  listModels,
  synthesize,
  isOnline,
  wavToSilk,
  loadSilk,
  cleanForTts,
  isSpeakable,
};

/**
 * Bot 根目录（Bot/ 本身）。
 *
 * ★ 2026-11-20 修 P0：原来写成 `${DATA_ROOT}/Bot`。
 *   DATA_ROOT 已经是 `.../Bot/dshqqbot`，再拼 `/Bot` 就成了
 *   `.../Bot/dshqqbot/Bot` —— 一个根本不存在的嵌套目录，
 *   语音缓存全写进了那里（实测已产生 `dshqqbot/Bot/人格/语音缓存/`）。
 *   按规范 §2.2：Bot/ 在 WORKSPACE_ROOT 下，不在 DATA_ROOT 下。
 */
const BOT_ROOT = `${WORKSPACE_ROOT}/Bot`;

/**
 * 参考音的本地候选（Bot 内保存的原件）。
 *
 * ★ 2026-11-20 去角色名硬编码：以前写死
 *   `Bot/人格/语音样本/爱莉希雅/g-06.wav` + `g-12.wav`，
 *   换人格或别人部署就找不到。现在按目录扫：
 *     ① 环境变量 BNN_VOICE_SAMPLE 指定的文件
 *     ② 语音样本根下每个子目录里的 .wav
 *     ③ 直接放在语音样本根下的 .wav
 *
 * @returns {string[]} 存在的候选绝对路径
 */
function refSourceCandidates() {
  const out = [];
  const envOne = String(process.env.BNN_VOICE_SAMPLE ?? '').trim();
  if (envOne && existsSync(envOne)) out.push(envOne);

  for (const sub of safeList(VOICE_SAMPLE_ROOT)) {
    const dir = join(VOICE_SAMPLE_ROOT, sub);
    if (!dirAvailable(dir)) continue;
    for (const f of safeList(dir, { filesOnly: true, exts: ['wav'] })) out.push(join(dir, f));
  }
  for (const f of safeList(VOICE_SAMPLE_ROOT, { filesOnly: true, exts: ['wav'] })) {
    out.push(join(VOICE_SAMPLE_ROOT, f));
  }
  return out;
}

/**
 * 确保参考音在 Voicebox 能读到的位置。
 *
 * @param {object} cfg
 * @returns {{ok:boolean, path?:string, reason?:string}}
 */
export function ensureReferenceAudio(cfg) {
  const target = String(cfg?.referenceAudioPath ?? '').trim();
  if (!target) return { ok: false, reason: 'NO_REF_PATH' };

  // ★ 为什么用 su：分区存储限制，Node 进程读不到 /sdcard/Android/data/<pkg>/
  //   Voicebox 自己有权限读，但我们要「确认存在 / 比对内容」就得走 root。

  /** 目标文件是否已在位（用 su 查）。 */
  const targetReady = () => {
    const check = spawnSync('su', ['-c', `test -r '${target}' && echo YES || echo NO`], { encoding: 'utf8' });
    return String(check.stdout || '').trim() === 'YES';
  };

  // ★ 2026-11-20 修：不再「文件存在就认为对」。
  //   主人在 App 里换参考音后，已部署的旧文件会一直留在 refs/ 里，
  //   API 读的是旧参考音 ⇒ 音色不对，但从代码看不出问题。
  //   现在比对源码与目标的内容哈希，不一致就重新部署（自愈）。
  const src = explicitRefSource(cfg) || refSourceCandidates()[0];
  const srcHash = src ? hashFileSync(src) : '';

  if (targetReady()) {
    if (!src || !srcHash) return { ok: true, path: target };
    const h = spawnSync('su', ['-c', `sha256sum '${target}' 2>/dev/null | cut -d' ' -f1`], { encoding: 'utf8' });
    const targetHash = String(h.stdout || '').trim();
    if (targetHash === srcHash) return { ok: true, path: target };
    // 内容不一致 → 落到下面重新部署
  }

  if (!src) return { ok: false, reason: 'NO_REF_SOURCE' };

  const dir = dirname(target);
  const cp = spawnSync('su', ['-c', `mkdir -p '${dir}' && cp '${src}' '${target}' && chmod 644 '${target}' && echo OK`], { encoding: 'utf8' });
  if (String(cp.stdout || '').trim() === 'OK') return { ok: true, path: target, deployed: true };
  return { ok: false, reason: 'DEPLOY_FAIL', detail: String(cp.stderr || '').slice(0, 120) };
}

/** 读文件哈希（同步，失败返回空串）。 */
function hashFileSync(p) {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * 显式参考音源：config.referenceSource（相对 Bot 根）。
 *
 * ★ 优先于目录扫描 —— 扫描是"按字典序取第一个"，多个角色目录并存时会取错人。
 */
function explicitRefSource(cfg) {
  const rel = String(cfg?.referenceSource ?? '').trim();
  if (!rel) return '';
  const abs = join(BOT_ROOT, rel.replace(/^Bot[\\/]/, ''));
  return existsSync(abs) ? abs : '';
}

/**
 * 缓存目录绝对路径。
 * @param {object} cfg
 */
export function cacheDirOf(cfg) {
  const rel = String(cfg?.cacheDir ?? DEFAULT_VOICE_CONFIG.cacheDir);
  return join(PERSONA_ROOT, rel.replace(/^人格[\/]/, ''));
}

/**
 * 用文本内容生成稳定的缓存文件名（同样的文本+音色复用）。
 * @param {string} text
 * @param {string} voice
 * @returns {string}
 */
function cacheKey(text, voice) {
  // 简单 FNV-1a，避免引入 crypto 依赖
  let h = 0x811c9dc5;
  const s = voice + '\u0000' + text;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 音色指纹 —— 决定「这是不是同一个声音」。
 *
 * ★ 2026-11-20 修（真隐患）：原来缓存 key 只用了 `modelId`。
 *   而主人换音色时**modelId 可能不变**（本次 Elysia_V5Turbo 就是同一 id 换了
 *   显示名 + 参考音 + 生成参数）⇒ 缓存会命中**旧音色**的 SILK 文件，
 *   同一句话返回旧声音，而且永远不重新生成 —— 从现象上看就是"改了配置没生效"。
 *
 *   现在把「决定音色的全部输入」一起算进指纹：
 *     引擎 + modelId + 语言 + 生成参数 + 参考文本 + 参考音内容哈希
 *   任意一项变化 ⇒ 指纹变化 ⇒ 缓存自然失效，旧文件靠 pruneCache 自然过期。
 *
 * 参考音用**工作区副本**算哈希（Node 能直接读）；拿不到就退化为路径字符串。
 *
 * @param {object} c 生效配置
 * @returns {string} 8 位十六进制指纹
 */
function voiceFingerprint(c) {
  let refPart = String(c?.referenceAudioPath ?? '');
  try {
    const rel = String(c?.referenceSource ?? '').trim();
    if (rel) {
      const abs = join(BOT_ROOT, rel.replace(/^Bot[\\/]/, ''));
      if (existsSync(abs)) {
        refPart = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
      }
    }
  } catch { /* 退化为路径 */ }

  const material = [
    'v2', // 指纹算法版本（改动算法就 bump，自动废掉旧缓存）
    String(c?.engine ?? ''),
    String(c?.modelId ?? ''),
    String(c?.language ?? ''),
    JSON.stringify(c?.genParams ?? {}),
    String(c?.referenceText ?? ''),
    refPart,
  ].join('\u0000');

  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 8);
}

/**
 * 清理过期缓存。
 * @param {object} cfg
 */
export function pruneCache(cfg) {
  const dir = cacheDirOf(cfg);
  if (!existsSync(dir)) return { removed: 0 };
  const days = Number(cfg?.cacheDays) > 0 ? Number(cfg.cacheDays) : 7;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.silk')) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { removed };
}

/**
 * **主入口**：文字 → SILK 文件。
 *
 * @param {string} text 要说的内容（可以是带 markdown 的原始回复）
 * @param {object} [cfg]
 * @param {{voice?:string, speed?:number, useCache?:boolean}} [opts]
 * @returns {Promise<{
 *   ok:boolean, silkPath?:string, durationSec?:number, spokenText?:string,
 *   reason?:string, detail?:string, cached?:boolean, elapsedMs?:number
 * }>}
 */
export async function speak(text, cfg, opts = {}) {
  const started = Date.now();
  const c = mergeVoiceConfig(cfg);

  if (c.enabled === false) return { ok: false, reason: 'DISABLED' };

  // ① 清洗文本
  const cleaned = cleanForTts(text, { maxChars: c.maxTextChars });
  if (!cleaned.ok) return { ok: false, reason: 'CLEAN_' + (cleaned.reason || 'FAIL') };
  const spoken = cleaned.text;

  // ★ 2026-11-20：缓存 key 从「modelId」升级为「音色指纹」。
  //   换模型/换参数/换参考音都会换指纹，从而不会命中旧音色的缓存。
  //   CloneTTS 分支仍用 voice alias（它没有参数/参考音概念）。
  const voiceKey = c.engine === 'voicebox'
    ? voiceFingerprint(c)
    : String(opts.voice ?? c.defaultVoice ?? '').trim();
  if (!voiceKey) return { ok: false, reason: c.engine === 'voicebox' ? 'NO_MODEL_ID' : 'NO_VOICE' };

  // ★ Voicebox 模式：确保参考音部署到位（放错目录会 EMPTY_SEMANTIC / 找不到）
  if (c.engine === 'voicebox') {
    const ref = ensureReferenceAudio(c);
    if (!ref.ok) {
      return { ok: false, reason: 'REF_' + ref.reason, detail: ref.detail, spokenText: spoken, elapsedMs: Date.now() - started };
    }
  }

  // ② 缓存命中
  const dir = cacheDirOf(c);
  const useCache = opts.useCache !== false;
  if (useCache) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const key = cacheKey(spoken, voiceKey);
      const path = join(dir, `${key}.silk`);
      if (existsSync(path)) {
        const st = statSync(path);
        return {
          ok: true, silkPath: path, spokenText: spoken, cached: true,
          durationSec: Number(st.size) / 6000, // 粗略估算（SILK 约 6KB/秒）
          elapsedMs: Date.now() - started,
        };
      }
    } catch { /* 缓存失败不算错，继续合成 */ }
  }

  // ③ 合成
  const tts = await synthesize(spoken, c, { voice: voiceKey, speed: opts.speed });
  if (!tts.ok) {
    return { ok: false, reason: 'TTS_' + tts.reason, detail: tts.detail, spokenText: spoken, elapsedMs: Date.now() - started };
  }

  // ④ WAV → SILK
  const silk = await wavToSilk(tts.wav, { antiAliasCutoff: c.antiAliasCutoff });
  if (!silk.ok) {
    return { ok: false, reason: 'SILK_' + silk.reason, detail: silk.detail, spokenText: spoken, elapsedMs: Date.now() - started };
  }

  // ⑤ 落盘
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const key = cacheKey(spoken, voiceKey);
    const path = join(dir, `${key}.silk`);
    writeFileSync(path, silk.silk);
    return {
      ok: true, silkPath: path, durationSec: silk.durationSec, spokenText: spoken,
      cached: false, elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false, reason: 'WRITE_FAIL', detail: e instanceof Error ? e.message : String(e),
      spokenText: spoken, elapsedMs: Date.now() - started,
    };
  }
}

/**
 * 诊断：返回当前语音能力状态。
 * @param {object} [cfg]
 */
export async function diagnose(cfg) {
  const c = mergeVoiceConfig(cfg);
  const errs = validateVoiceConfig(c);
  const silkLib = await loadSilk();
  const online = await isOnline(c);
  const models = online ? await listModels(c) : { ok: false };

  return {
    enabled: c.enabled,
    engine: c.engine,
    apiBase: c.apiBase,
    modelId: c.modelId,
    language: c.language,
    referenceAudioPath: c.referenceAudioPath,
    referenceTextLen: String(c.referenceText || '').length,
    cacheDir: cacheDirOf(c),
    cfgErrors: errs,
    silkLib: !!silkLib,
    apiOnline: online,
    models: models.ok ? models.models : null,
  };
}
