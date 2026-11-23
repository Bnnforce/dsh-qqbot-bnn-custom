/**
 * voice/config — 语音合成配置（2026-11-19 改用 Voicebox）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么从 CloneTTS 换成 Voicebox：
 *
 *   ① CloneTTS 的 `speed` 参数有 bug —— 传了就慢一倍（实测 0.95s → 1.86s）
 *   ② Voicebox 支持直接导入 GPT-SoVITS 专训权重
 *      （主人已训练好爱莉模型：elysia_v2Pro）
 *   ③ 音质：Voicebox = GPT-SoVITS 架构，业界公认比 ZipVoice 好
 *
 * ── 两个引擎的差异 ─────────────────────────────────────────────────────────
 *
 *   CloneTTS (port 8080):
 *     GET /api/tts?text=&voice=qingya
 *     → 音色是"参考音克隆"，无专训模型
 *
 *   Voicebox (port 16580):
 *     POST /infer { modelId, language, text, referenceAudioPath, referenceText }
 *     → 音色是"专训权重 + 参考音"
 *
 * 设计红线（为开源准备）：
 *   ① 不写死主机/端口 —— 全部走配置
 *   ② 模型 ID / 参考音路径 —— 全部可配
 *   ③ 失败关闭 —— 任何异常都返回结构化失败，绝不抛
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const DEFAULT_VOICE_CONFIG = {
  /** 总开关。 */
  enabled: true,

  /** 引擎类型：'voicebox' | 'clonetts'（保留兼容） */
  engine: 'voicebox',

  /** Voicebox HTTP API 基址。 */
  apiBase: 'http://127.0.0.1:16580',

  /**
   * 当前模型 ID。
   *
   * ★ 2026-11-20 22:49 主人换成 **Elysia_V5Turbo**（v5turbo 架构）。
   *   注意：**modelId 没变**，还是 `imported-850dcc44-…` ——
   *   上游是「同一个模型目录 = 同一个 id」，主人只是在 App 里换了显示名
   *   （`prompt_wav.json` 的 `display_name: "Elysia_V5Turbo"`）并换了参考音。
   *   所以只改参数 + 参考音，id 保持。用 `GET /models` 可核对 id↔显示名。
   */
  modelId: 'imported-850dcc44-37b0-4abd-b4d7-624c8738b20c',

  /** 合成语言。 */
  language: 'zh',

  /**
   * 生成参数（显式传给 API）。
   *
   * ★ 为什么必须显式传：实测 App UI 里的配置**不会同步**给 API。
   *   API 是独立入口，不传就用它自己的默认值。
   *
   * ★★ 2026-11-20 第三次校对（已漂过三次）：
   *   这组值**必须**与 App 里的当前设置逐项一致，否则听起来就是"另一个人"。
   *   App 侧真源：`/data/data/dev.rinstel.genie_tts/shared_prefs/voice_studio.xml`
   *   （读它需要 root；非 root 只能在 App 里人工看）。
   *
   *   漂移自检：`node 维护/05-工具/check-voice-config.mjs`（需 root）
   *   temperature 范围 0~1（1.5 会报 "temperature must be between 0 and 1"）
   */
  genParams: {
    temperature: 0.73,
    topK: 76,
    topP: 0.85,
    repetitionPenalty: 1.55,
    /** App 里 speed=1.0；显式传，避免 API 默认值与 App 不一致。 */
    speed: 1.0,
  },

  /**
   * 参考音源（相对 Bot 根的工作区副本）。
   *
   * 由 `维护/05-工具/check-voice-config.mjs --sync` 从 App 的
   * `CharacterModels/<arch>/<modelId>/prompt_wav/reference-*.wav` 同步过来 ——
   * 工作区这份是可备份/可版本化的**真源**，App 那边的文件名带 UUID 会变。
   */
  referenceSource: '人格/语音样本/Elysia_V5Turbo/ref.wav',

  /**
   * 参考音部署路径（App 能读、我们能写的位置）。
   * ⚠️ 必须放在 App 可访问的持久目录：
   *    /sdcard/Android/data/dev.rinstel.genie_tts/files/refs/
   * （放 cache/ 会被 App 用完删除；放 Downloads 会被分区存储拒绝）
   * ★ 2026-11-20：改为可被环境变量覆盖 —— 换机/换角色不用改代码。
   */
  referenceAudioPath: process.env.BNN_VOICE_REF_AUDIO
    || '/sdcard/Android/data/dev.rinstel.genie_tts/files/refs/elysia-v5turbo-ref.wav',

  /**
   * 参考音对应的逐字文本。
   * ⚠️ 必须与音频完全一致，否则报 EMPTY_SEMANTIC。
   * 当前值取自 App 的 `prompt_wav.json` → `Normal.text`（Elysia_V5Turbo）。
   */
  referenceText: process.env.BNN_VOICE_REF_TEXT
    || '执拗的花朵永远不会因暴雨而褪去颜色，你的决心也一定能在绝境中绽放真我。',

  /** 单次合成超时（毫秒）。CPU 模式 2 秒音频约 1.3-1.6 秒。 */
  timeoutMs: 60000,

  /**
   * 抗混叠低通截止频率（Hz）。**0 = 不滤波（默认）**。
   *
   * ★ 2026-11-19 主人决定：去掉所有滤波器/增益，只靠生成参数优化。
   *   保留这个开关是为了以后需要时能一键恢复：
   *     0     → 纯净转码（32k/24k 直接线性插值到 16k）
   *     4000  → 抗混叠 + 压 3.5kHz 刺耳感（实测明显柔和）
   *     7200  → 只抗混叠，不动音色
   */
  antiAliasCutoff: 0,

  /** 文本长度上限（字符）。 */
  maxTextChars: 200,

  /** 音频缓存目录（相对 Bot 根）。 */
  cacheDir: '人格/语音缓存',

  /** 缓存保留天数。 */
  cacheDays: 7,
};

/**
 * 合并配置（用户配置覆盖默认）。
 * @param {object} [raw]
 * @returns {object}
 */
export function mergeVoiceConfig(raw) {
  const c = { ...DEFAULT_VOICE_CONFIG };
  if (!raw || typeof raw !== 'object') return c;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    c[k] = v;
  }
  const t = Number(c.timeoutMs);
  c.timeoutMs = Number.isFinite(t) && t > 0 ? t : 60000;
  const m = Number(c.maxTextChars);
  c.maxTextChars = Number.isFinite(m) && m > 0 ? m : 200;
  return c;
}

/**
 * 校验配置，返回错误列表（空 = 合法）。
 * @param {object} cfg
 * @returns {string[]}
 */
export function validateVoiceConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['config 不是对象'];
  if (typeof cfg.enabled !== 'boolean') errs.push('enabled 必须是布尔');
  if (!/^https?:\/\//.test(String(cfg.apiBase ?? ''))) errs.push('apiBase 必须是 http(s) URL');
  const eng = String(cfg.engine ?? 'voicebox');
  if (!['voicebox', 'clonetts'].includes(eng)) errs.push(`engine 非法: ${eng}`);
  if (eng === 'voicebox') {
    const gp = cfg.genParams;
    if (!gp || typeof gp !== 'object') errs.push('genParams 必须是对象');
    else {
      const tp = Number(gp.temperature);
      if (!(tp >= 0 && tp <= 1)) errs.push(`temperature 必须在 0~1（当前 ${gp.temperature}）`);
    }
    if (!String(cfg.modelId ?? '').trim()) errs.push('voicebox 模式必须配 modelId');
    if (!String(cfg.referenceAudioPath ?? '').trim()) errs.push('voicebox 模式必须配 referenceAudioPath');
    if (!String(cfg.referenceText ?? '').trim()) errs.push('voicebox 模式必须配 referenceText');
    if (!String(cfg.language ?? '').trim()) errs.push('voicebox 模式必须配 language');
  }
  return errs;
}