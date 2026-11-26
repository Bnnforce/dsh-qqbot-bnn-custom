/**
 * chronicle/narrative — 把事件账本变成「编年史」的 LLM 提示词（R7.1）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 本文件**只生成 prompt，不调 LLM**。
 *
 *   为什么这样拆：调 LLM 是唯一成本点（方案 §4.4），且失败必须「保留旧群史、
 *   不覆盖」。把「决定说什么」和「怎么发请求」分开，才能做到：
 *     · 提示词可单测（同样的输入必须给同样的文本，便于 review 和回归）
 *     · 调用方（定时任务）自由决定服务来源、超时、降级
 *     · LLM 不可用时这一层零副作用
 *
 * ── 三条硬约束（方案 §4.4 + 红线）─────────────────────────────────────────
 *
 *   ① **只喂事件摘要，不喂原消息**（控 token，且原始聊天不进 prompt 就没法泄漏）
 *   ② **明确要求「只写事件里有的，不编造」** —— 群史是"记忆"，编出来的记忆
 *      比没有记忆更糟：她会在群里讲一件没发生过的事，并被群友当场纠正
 *   ③ **任何输出文本不含 32 位 hex openid**：participants 是内部账本字段，
 *      这里只取**人数**，openid 本身绝不进 prompt
 *
 * ── 输出长度 ──────────────────────────────────────────────────────────────
 *
 *   150 字以内（方案：一屏看完、能贴进 `/群史` 回显）。
 *   ⚠️ 严格要求模型"数到 150 字"是不可靠的，所以调用方还应在拿到结果后再截断；
 *   本模块只在 prompt 里写明上限，并在返回前对 prompt 自身做 openid 兜底脱敏。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { redactOpenids } from './extract.mjs';

/** 编年史正文的目标字数上限（给模型看的）。 */
export const TARGET_CHARS = 150;

/** 喂给模型的最多事件条数：再多 token 涨，群史也不会更具体。 */
export const MAX_EVENTS_IN_PROMPT = 40;

/** 安全取数字（非法回 0）。 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 安全取字符串。 */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 一条事件 → 一行摘要（**只用可观测字段，不猜内容**）。
 *
 * 刻意不写「群里聊了什么」这种需要理解原消息的句子：本模块手里没有原文，
 * 硬写就会变成编造。只给模型这些它**真的知道**的事实：
 * 日期、几点、几个人、多少条、持续多久、热度。
 *
 * @param {object} e
 * @returns {string}
 */
function eventLine(e) {
  const ev = e && typeof e === 'object' ? e : {};
  const date = str(ev.date) || '某天';
  const start = num(ev.startAt);
  const end = num(ev.endAt);

  // 起止都按同一偏移（默认东八区）取小时：集群 TZ 不该影响群史的"几点"
  const clock = (ms) => {
    const d = new Date(ms + 8 * 60 * 60000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  const span = start > 0 && end >= start ? `${clock(start)}~${clock(end)}` : '某时';

  const people = Array.isArray(ev.participants) ? ev.participants.length : num(ev.participants);
  const msgCount = num(ev.msgCount);
  const minutes = start > 0 && end >= start ? Math.round((end - start) / 60000) : 0;
  const heat = num(ev.emotionPeak);

  const bits = [`${date} ${span}`];
  bits.push(`${people} 人参与`);
  if (msgCount > 0) bits.push(`${msgCount} 条消息`);
  if (minutes > 0) bits.push(`持续约 ${minutes} 分钟`);
  // 热度只给三档人话，别让模型对着小数编故事
  if (heat >= 0.6) bits.push('气氛很热烈');
  else if (heat >= 0.3) bits.push('气氛比较活跃');
  return `- ${bits.join('，')}`;
}

/**
 * 生成编年史提示词（纯函数）。
 *
 * @param {string} gid 群 id（**只做内部标识，不写进 prompt 正文**，避免任何 hex 泄漏）
 * @param {Array<object>} events extractEvents 的事件数组（建议已按 qualified 过滤）
 * @param {object} [opts]
 * @param {number} [opts.maxEvents] 最多几条事件（默认 40）
 * @param {boolean} [opts.includeMeta] 是否附一段给调用方的人读说明（默认 false）
 * @returns {string} 可作为 user message 的提示词；无事件时返回「群史还在长」的提示词
 */
export function buildChroniclePrompt(gid, events, opts = {}) {
  // ⚠️ gid **故意完全不用**：它本身就是 32 位 hex，一旦出现在 prompt 里就是泄漏。
  //    调用方传它是为了「同一处拿到群上下文」的便利，本函数只做丢弃。
  void gid;

  const list = Array.isArray(events)
    ? events.filter((e) => e && typeof e === 'object')
    : [];
  const maxEvents = Math.max(1, Math.min(200, Math.floor(num(opts?.maxEvents)) || MAX_EVENTS_IN_PROMPT));

  // 只取够格的事件；若调用方没标 qualified，就全用（信任调用方已过滤）
  const qualified = list.filter((e) => e.qualified !== false);
  const picked = qualified.slice(0, maxEvents);

  const lines = [];
  lines.push('你在为一个 QQ 群写「群史」——这个群一起经历过的事情的记录。');
  lines.push('语气温柔、自然、像在回忆，不要写成流水账，不要列清单。');
  lines.push('');

  if (!picked.length) {
    lines.push('（这段时间群里还没有够格成为共同记忆的事，群史还在长。）');
    lines.push('');
    lines.push('请只回一句话，说明这段群史还很短、之后会慢慢长出来。不要编造任何事件。');
    return redactOpenids(lines.join('\n')).text;
  }

  lines.push('以下是从群里提炼出的事件（只有可观测事实，没有聊天原文）：');
  for (const e of picked) lines.push(eventLine(e));
  lines.push('');

  lines.push('请把上面这些事件写成一段 150 字以内的群史。');
  lines.push('');
  lines.push('铁律：');
  lines.push('· 只写上面事件里有的信息，不编造、不脑补、不补充细节');
  lines.push('· 不知道聊了什么内容就写「聊了一阵」，不要猜话题');
  lines.push('· 不出现任何群友的昵称、openid、群号，用「大家」「有人」代指');
  lines.push('· 不写具体时间戳，必要时说「那天晚上」「有一回」即可');
  lines.push('· 150 字以内，一段话，直接输出正文，不加标题、不加引号、不加旁白');

  // 双保险：即使上游某天把 openid 混进了 date/其他字段，出口也不会漏
  return redactOpenids(lines.join('\n')).text;
}

/**
 * 编年史生成时的 system 提示词（与 user prompt 配套）。
 *
 * 单独导出，是为了让调用方（走 kernel.get('llm') 的定时任务）不必自己编
 * system —— 以前 diary 那边两处各写一份，改一处漏一处。
 *
 * @returns {string}
 */
export function buildChronicleSystem() {
  return [
    '你是一个温柔、细腻、记性很好的角色，负责写群聊的编年史。',
    '你只根据给定的事实写，绝不虚构没发生过的事。',
    '你的文字克制、不煽情，像真实的人在回忆一群朋友。',
  ].join('\n');
}

/**
 * 把 LLM 的原始输出清洗成可落盘的编年史正文。
 *
 * 模型再听话也会偶尔加「以下是群史：」或引号，这里统一剥掉；
 * 并且**强制截到 150 字**（方案要求），超长时补省略号。
 *
 * @param {string} raw LLM 输出
 * @param {object} [opts]
 * @param {number} [opts.maxChars] 字数上限（默认 150）
 * @returns {string} 清洗后的正文；无效输入返回 ''
 */
export function sanitizeChronicleText(raw, opts = {}) {
  if (typeof raw !== 'string') return '';
  let text = raw
    .replace(/^\s*#+\s*/gm, '')                       // 标题井号
    .replace(/^\s*(以下是|下面是)?(这个群的)?群史[:：]\s*/m, '')
    .trim()
    .replace(/^["'「『]+/, '')
    .replace(/["'」』]+$/, '')
    .trim();
  if (!text) return '';

  const max = Math.max(20, Math.floor(num(opts?.maxChars)) || TARGET_CHARS);
  const chars = [...text];
  if (chars.length > max) text = `${chars.slice(0, max - 1).join('')}…`;

  return redactOpenids(text).text;
}

export default {
  TARGET_CHARS,
  MAX_EVENTS_IN_PROMPT,
  buildChroniclePrompt,
  buildChronicleSystem,
  sanitizeChronicleText,
};
