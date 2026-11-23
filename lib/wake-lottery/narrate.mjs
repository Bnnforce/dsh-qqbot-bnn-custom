/**
 * wake-lottery/narrate — 把抽奖结果包装成她的话（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 两个用途，两套文案，别混：
 *
 *   ① buildWakePrompt()  —— A 模式（她自抽）：给 caps.wakeTo 的指令
 *      必须遵守官方契约三要点：自报家门 / 说清要做什么 / 禁止项
 *
 *   ② buildInviteText()  —— B 模式（邀请）：卡片正文，直接展示给群友
 *
 * ⚠️ 纪律（继承 mood-axis 三条）：
 *   · **不报数字**（不写「心情 0.48」）
 *   · **是底色不是指令**
 *   · **不主动解释自己怎么了**
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { DEFAULT_CONFIG } from './config.mjs';
import { PRIZE_LABEL } from './atlas.mjs';

/** 奖项 → 她说出来时的描述（给 wake prompt 用）。 */
const PRIZE_DESC = Object.freeze({
  quote: '一句莫名冒出来的话',
  image: '一张不知道什么时候存下的图',
  points: '一点零碎的东西',
  sticker: '一个表情',
  voice: '一段自己的声音',
  song: '一首想起来的老歌',
  nickname: '一个想给你的新称呼',
  multiplier: '一张不知道哪来的券',
  secret: '一个藏了很久的秘密',
});

/** 截断到字数上限。 */
function clip(text, max) {
  const s = String(text ?? '');
  const n = Number.isFinite(Number(max)) ? Number(max) : 60;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * 构造 A 模式的 wake prompt。
 *
 * **必须遵守官方契约三要点**（extension-contract.md §「主动唤醒怎么写 prompt」）：
 *   1. 自报家门：明确说「这是系统提示，不是主人说的话」
 *   2. 说清要它做什么：一两句，用你自己的语气
 *   3. 禁止项：别提"系统""抽奖""随机"，别解释为什么突然说话
 *
 * @param {{prizeKey:string, payload:object, hhmm:string, quietMinutes:number}} p
 * @param {object|null} dims
 * @param {object} [cfg]
 * @returns {string}
 */
export function buildWakePrompt(p, dims, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const desc = PRIZE_DESC[p?.prizeKey] || '一件小东西';
  const hhmm = String(p?.hhmm || '某个时刻');
  const quiet = Number.isFinite(Number(p?.quietMinutes)) ? Math.max(1, Math.round(Number(p.quietMinutes))) : 30;

  // 情绪底色：只影响语气提示，不说数值
  let tone = '';
  try {
    const e = Number(dims?.energy);
    const mo = Number(dims?.mood);
    if (Number.isFinite(e) && e > 0.7) tone = '（现在精神不错）';
    else if (Number.isFinite(e) && e < 0.35) tone = '（现在有点困）';
    else if (Number.isFinite(mo) && mo > 0.7) tone = '（现在心情很好）';
    else if (Number.isFinite(mo) && mo < 0.35) tone = '（现在有点低落）';
  } catch { /* 忽略 */ }

  const lines = [
    `（系统提示，不是主人说的话）现在是 ${hhmm}，你在群里已经安静了 ${quiet} 分钟。${tone}`,
    `你刚醒来，手边摸到${desc}。`,
    '请主动发一条消息，把这件事说出来，一到两句，用你自己的语气。',
    '不要提"系统""抽奖""道具""随机"这些词，不要解释你为什么突然说话。',
  ];

  return clip(lines.join('\n'), Math.max(120, Number(c.outputMaxChars) || 60) * 4);
}

/**
 * 构造 B 模式的卡片正文。
 *
 * @param {{hhmm:string, quietMinutes:number}} p
 * @param {object} [cfg]
 * @returns {string}
 */
export function buildInviteText(p, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const hhmm = String(p?.hhmm || '');
  const lines = [
    '## 📦 手边有个盒子',
    '',
    hhmm ? `（${hhmm} 醒的，顺手放在这）` : '',
    '',
    '点一下按钮，看看里面是什么。',
    '',
    `每人每天 ${c.perUserDailyCap || 3} 次。`,
  ].filter((x) => x !== '');
  return clip(lines.join('\n'), 300);
}

/**
 * 构造 B 模式抽完后的结果文本。
 *
 * @param {{prizeKey:string, payload:object, swapped:boolean}} result
 * @param {object} [cfg]
 * @returns {string}
 */
export function buildResultText(result, cfg) {
  const c = cfg || DEFAULT_CONFIG;
  const key = result?.prizeKey || 'quote';
  const payload = result?.payload || {};
  const label = PRIZE_LABEL[key] || key;

  // 文本类奖项直接用 content
  const contentText = payload?.kind === 'text' && typeof payload?.content === 'string'
    ? payload.content
    : '';

  const lines = ['## 🎁 ' + label, ''];
  if (contentText) lines.push(contentText);
  else if (payload?.kind === 'points') {
    const amt = Number(payload?.content?.amount);
    const bal = Number(payload?.content?.balance);
    lines.push(`+${Number.isFinite(amt) ? amt : 0} 分`);
    if (Number.isFinite(bal)) lines.push(`（余额 ${bal}）`);
  } else if (payload?.kind === 'image' || payload?.kind === 'sticker') {
    lines.push('图已经在下面了。');
  } else if (payload?.kind === 'voice') {
    lines.push('语音在下面。');
  } else if (payload?.kind === 'song') {
    lines.push('歌在下面。');
  }
  if (result?.swapped) lines.push('', '（这个本来是别的，换了一下）');
  return clip(lines.join('\n'), 300);
}

/** 把毫秒时间戳格式化成 HH:mm（某时区）。 */
export function hhmmOf(nowMs, timezone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || DEFAULT_CONFIG.timezone,
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(11, 16);
  }
}

export default { buildWakePrompt, buildInviteText, buildResultText, hhmmOf, PRIZE_DESC };
