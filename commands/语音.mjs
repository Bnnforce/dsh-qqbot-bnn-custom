/**
 * /语音 —— 让爱莉用真声说话（2026-11-18）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用法：
 *   /语音 今天天气真好        → 合成这句话并发语音
 *   /语音（无参数）             → 让她说一句随机的话
 *   /语音 帮助                 → 显示用法
 *
 * ── 技术链路 ───────────────────────────────────────────────────────────────
 *   文字 → 清洗 → Voicebox /infer（爱莉专训模型）→ WAV → silk-wasm → SILK → MEDIA:voice
 *
 * ── 工业纪律 ───────────────────────────────────────────────────────────────
 *   ① 免费功能，不扣积分（语音是基础设施，不是消费）
 *   ② 失败必须给出可读原因（不说"出错了"）
 *   ③ 首次调用要检查服务在线，离线时明确提示
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { commandPeer } from '../lib/pure/card-kit.mjs';
import { EXT_ROOT } from '../lib/pack-paths.mjs';

const VOICE_LIB = `${EXT_ROOT}/lib/voice/index.mjs`;

async function voiceMod() {
  return import(VOICE_LIB + '?v=' + Date.now());
}

/** 无参数时的随机台词（爱莉口吻）。 */
const RANDOM_LINES = [
  '在呀，听到爱莉的声音了吗？',
  '今天也要好好陪着我哦。',
  '嗯……我在想事情呢，被你打断了。',
  '你来了呀，正好想找人说说话。',
  '这段时间过得怎么样？跟我说说嘛。',
];

async function say(ctx, md) {
  const caps = ctx?.caps ?? ctx;
  if (typeof caps?.markdown === 'function') {
    try {
      const ok = await caps.markdown(md);
      if (ok) return '';
    } catch { /* 落到返回文本 */ }
  }
  return md;
}

/** 失败原因 → 人话。 */
function humanReason(reason, detail) {
  const m = {
    TTS_TIMEOUT: '语音服务响应太慢，稍后再试。',
    TTS_NETWORK: '语音服务没连上，可能被系统清理了。',
    TTS_NOT_WAV: '语音服务返回了异常内容。',
    TTS_HTTP_500: '语音服务内部错误。',
    SILK_NO_SILK_LIB: '转码组件缺失。',
    SILK_ENCODE_EMPTY: '转码失败。',
    SILK_NOT_16BIT: '音频格式不支持。',
    SILK_NOT_MONO: '音频格式不支持。',
    CLEAN_EMPTY: '这句话没有可以念的内容。',
    CLEAN_EMPTY_AFTER_CLEAN: '这句话没有可以念的内容。',
    DISABLED: '语音功能关着。',
    NO_VOICE: '没配置音色。',
  };
  return m[reason] || `语音合成失败（${reason}${detail ? ': ' + String(detail).slice(0, 40) : ''}）`;
}

export default {
  name: ['语音', 'voice', 'tss'],
  description: '让爱莉用真声说话',
  usage: '/语音 [要说的话]',

  async handler(ctx) {
    const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();
    const { gid } = commandPeer(ctx);

    // ★ 2026-11-26 合规：modelId 原本硬编码部署者的私有 TTS 模型 id。
    //   现在改为 env BNN_VOICE_MODEL_ID 覆盖、默认空。留空时给出人话提示。
    try {
      const V = await voiceMod();
      const cfg = V.resolveVoiceConfig?.() ?? {};
      if (cfg.enabled === true && !String(cfg.modelId || '').trim()) {
        return await say(ctx, [
          '## 🔊 语音还没配好',
          '',
          '需要指定本地 TTS 的模型 id。',
          '在 DSH 的环境变量里设 BNN_VOICE_MODEL_ID=<你的模型id> 即可。',
          '',
          '（用 GET /models 能列出 Voicebox 里已有的模型 id）',
        ].join('\n'));
      }
    } catch { /* 探不到配置就让后面的正常流程报错 */ }

    // ── 帮助 ──
    if (/^(帮助|help|\?|？)$/i.test(raw)) {
      return await say(ctx, [
        '## 🔊 语音合成',
        '',
        '`/语音 <要说的话>`　让她念出来',
        '`/语音`　随便说一句',
        '',
        '（音色是爱莉希雅，本地合成，不上传云端）',
      ].join('\n'));
    }

    let V;
    try {
      V = await voiceMod();
    } catch (e) {
      return await say(ctx, `语音模块加载失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // ── 选文本 ──
    let text = raw;
    if (!text) {
      text = RANDOM_LINES[Math.floor(Math.random() * RANDOM_LINES.length)];
    }

    // ── 长度提示 ──
    if ([...text].length > 200) {
      return await say(ctx, `太长了（${[...text].length} 字），200 字以内。`);
    }

    // ── 先检查服务在线（首次误报会浪费 30 秒）──
    const online = await V.isOnline();
    if (!online) {
      return await say(ctx, [
        '## 🔇 语音服务没开',
        '',
        'Voicebox 的本地 API 没连上。',
        '',
        '请打开 Voicebox App（设置里确认「本地 HTTP 服务」已开启）。',
      ].join('\n'));
    }

    // ── 合成 ──
    const started = Date.now();
    const r = await V.speak(text);
    const elapsed = Date.now() - started;

    if (!r.ok) {
      return await say(ctx, `🔇 ${humanReason(r.reason, r.detail)}`);
    }

    // ── 发语音 ──
    //   QQ 语音通过 MEDIA:voice 发送：在正文里写标记，由宿主转成语音气泡
    const caps = ctx?.caps ?? ctx;
    let sent = false;

    // 优先用 caps 的 voice/media 能力（官方扩展契约）
    if (typeof caps?.voice === 'function') {
      try {
        const ok = await caps.voice({ localPath: r.silkPath });
        if (ok) sent = true;
      } catch { /* 落到 sendMedia */ }
    }
    if (!sent && typeof caps?.media === 'function') {
      try {
        const ok = await caps.media('voice', { localPath: r.silkPath });
        if (ok) sent = true;
      } catch { /* 落到 MEDIA 标记 */ }
    }
    if (!sent && typeof caps?.sendMedia === 'function') {
      try {
        const ok = await caps.sendMedia({ localPath: r.silkPath, kind: 'voice' });
        if (ok) sent = true;
      } catch { /* 落到 MEDIA 标记 */ }
    }

    // 兜底：用 MEDIA 标记（宿主会解析）
    //   ★ 这是最可靠的路径：官方文档明确支持 [MEDIA:voice|本地路径]
    if (!sent) {
      return `[MEDIA:voice|${r.silkPath}]`;
    }

    // 已发送 → 不再回复文字（避免"语音+文字"两条）
    return '';
  },
};