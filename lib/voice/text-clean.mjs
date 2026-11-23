/**
 * voice/text-clean — 语音合成前的文本清洗（2026-11-18）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须清洗：
 *
 * CloneTTS 官方警告：「`ref.txt` 必须和音频**逐字对齐**。如果里面混进了
 * `~ ～ … — ♪` 这类不是字的东西，模型会对齐错，合成结果开头会冒出随机的怪音」
 *
 * 爱莉的回复里经常有：
 *   · markdown（**加粗**、`代码`、# 标题）
 *   · 表情符号（🌸、♪、✨）
 *   · 括号补充（（笑））
 *   · 多余的波浪号、省略号
 *
 * 这些直接喂给 TTS 会：
 *   ① 被念出来（"星号星号"）
 *   ② 或者让对齐错位产生怪音
 *
 * 所以必须先洗成"干净的、可朗读的中文"。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 清洗后为空时用的兜底（避免合成空字符串）。 */
const FALLBACK = '嗯。';

/**
 * 清洗文本，输出适合 TTS 朗读的纯文本。
 *
 * @param {string} raw
 * @param {{maxChars?:number, keepPunct?:boolean}} [opts]
 * @returns {{ok:boolean, text:string, changed:boolean, reason?:string}}
 */
export function cleanForTts(raw, opts = {}) {
  const src = String(raw ?? '');
  if (!src.trim()) return { ok: false, text: '', changed: false, reason: 'EMPTY' };

  let t = src;

  // ── ① 去掉 markdown 结构 ──
  t = t.replace(/```[\s\S]*?```/g, '');            // 代码块
  t = t.replace(/`([^`]*)`/g, '$1');                // 行内代码 → 保留内容
  t = t.replace(/^#{1,6}\s*/gm, '');                // 标题井号
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');          // 加粗
  t = t.replace(/\*([^*]+)\*/g, '$1');              // 斜体
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/_([^_]+)_/g, '$1');
  t = t.replace(/~~([^~]+)~~/g, '$1');              // 删除线
  t = t.replace(/^\s*[-*+]\s+/gm, '');              // 列表符号
  t = t.replace(/^\s*\d+\.\s+/gm, '');              // 有序列表
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');  // 链接/图片
  t = t.replace(/^>\s?/gm, '');                     // 引用
  t = t.replace(/^[-*_]{3,}\s*$/gm, '');            // 分隔线

  // ── ② 去掉表情/符号（★ 关键：会破坏对齐）──
  //   emoji 区间 + 常见装饰符
  t = t.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');     // emoji
  t = t.replace(/[\u{2600}-\u{27BF}]/gu, '');       // 杂项符号
  t = t.replace(/[\u{FE00}-\u{FE0F}]/gu, '');       // 变体选择符
  t = t.replace(/[♪♫♬♩]/g, '');                     // 音符
  t = t.replace(/[~\u301C\uFF5E]/g, '，');          // 波浪号 → 停顿
  t = t.replace(/[…#⋯]/g, '，');                    // 省略号 → 停顿
  t = t.replace(/[—–]/g, '，');                     // 破折号 → 停顿

  // ── ③ 括号内容处理 ──
  //   动作描写（（笑）（叹气））→ 去掉，不是台词
  t = t.replace(/[（(][^）)]{0,20}[）)]/g, '');
  //   【】〔〕之类保留内容但去壳
  t = t.replace(/[【〔《「『]([^】〕》」』]*)[】〕》」』]/g, '$1');

  // ── ④ 空白与标点整理 ──
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[，,]{2,}/g, '，');
  t = t.replace(/^[，,。.！!？?、\s]+/, '');          // 去开头标点
  // ★ 2026-11-19 修：结尾只去「逗号/顿号」，**保留句号问号感叹号**。
  //   删掉句末标点会让 TTS 不知道句子结束 —— 没有降调、没有停顿，
  //   实测听起来「一口气念完、连续性太连续」。
  t = t.replace(/[，,、\s]+$/, '');

  // ── ⑤ 长度限制 ──
  const max = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 0;
  if (max > 0 && [...t].length > max) {
    // 按标点切到 max 以内（避免切半句）
    const chars = [...t];
    let cut = max;
    for (let i = max; i > Math.floor(max * 0.5); i--) {
      if ('，。！？；、'.includes(chars[i])) { cut = i; break; }
    }
    t = chars.slice(0, cut).join('').replace(/[，,、\s]+$/, '');
  }

  if (!t.trim()) return { ok: false, text: '', changed: true, reason: 'EMPTY_AFTER_CLEAN' };

  const changed = t !== src;
  // 太短（<2 字）加个语气词，否则 TTS 容易出怪音
  if ([...t].length < 2) t = t + FALLBACK;

  return { ok: true, text: t, changed };
}

/**
 * 粗略判断这段文本适不适合转语音。
 *
 * 不适合的情况：
 *   · 纯符号/表情
 *   · 主要是代码
 *   · 太长（超过 200 字，合成要很久）
 *
 * @param {string} raw
 * @param {number} [maxChars]
 * @returns {{ok:boolean, reason?:string, chars:number}}
 */
export function isSpeakable(raw, maxChars = 200) {
  const c = cleanForTts(raw, { maxChars });
  if (!c.ok) return { ok: false, reason: c.reason, chars: 0 };
  const chars = [...c.text].length;
  if (chars > maxChars) return { ok: false, reason: 'TOO_LONG', chars };
  if (chars < 2) return { ok: false, reason: 'TOO_SHORT', chars };
  return { ok: true, chars };
}