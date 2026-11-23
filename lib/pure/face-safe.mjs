/**
 * face-safe.mjs — 表情控制字符（QQ face）安全处理
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要
 *
 * qqbot 自 **1.13.18** 起有个「表情彩蛋」：模型若写 `【表情: 狂笑】`，
 * 出站时会把它替换成**真的 QQ 表情** —— 也就是控制字符
 * `U+0014` + 一个 face id 字符（`String.fromCharCode(20, id)`）。
 *
 * 关键时序（读 1.13.20 `dist/transport/outbound.js` 确认）：
 *
 *   OutboundBuffer.flush()
 *     → stripFn(buffer)            ← 官方在这里做「表情替换 + 剥时间头」
 *     → sendRichOutbound(...)      ← **我们的出站扩展链在这里跑**
 *
 * 也就是说：**出站扩展拿到的正文里已经含有裸控制字符**。
 * 而我们有一批模块会对正文做字符串操作（拆气泡、正则清洗、去重、脱敏…），
 * 一旦碰到 `U+0014` 与它的 id 之间，表情就被拆散/吞掉 —— 群里看到的
 * 要么是空白，要么是乱码，而且**报错日志里什么都看不出来**。
 *
 * 上游自己也踩过同款的坑：`transport/chunker.js` 专门加了
 * 「切块不能切在 face 编码中间」的判定（并写明不能只看 `charCodeAt(end-1)===0x14`，
 * 因为内置「害羞」的编码是 `[20,20]`，第二个 0x14 是 id 不是前导符）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 本模块的做法：**掩码**
 *
 *   maskFaces(text) → { text, restore }   // 每个 face 换成一个私用区占位符
 *   …对 masked.text 做任意字符串操作…
 *   restore(result)                       // 按顺序换回真表情
 *
 * 掩码后占位符是**普通可见字符**（私用区 U+E000），所以：
 *   · 正则、split、trim、字数统计都不会碰到控制字符；
 *   · 顺序保持不变 ⇒ restore 能正确还原；
 *   · split 时若把占位符分到不同气泡，各自 restore 也能还原（每个面独立）。
 *
 * 用法（拆气泡为例）：
 *
 *   const { text: masked, restore } = maskFaces(raw);
 *   const bubbles = splitMine(masked);
 *   return bubbles.map(restore);
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** QQ face 前导控制字符。 */
export const FACE_LEAD = '\u0014';

/**
 * 占位符区：私用区 U+E000 起，**每个 face 一个不同码位**。
 *
 * ★ 为什么要编号（2026-11-20 测试抓到的设计缺陷）：
 *   最初所有 face 都换成同一个 `\uE000`，还原靠"按出现顺序递增的游标"。
 *   那让 restore **有状态**：同一份掩码文本拆成两段、分两次 restore 时，
 *   第二段会从游标 0 重新取 ⇒ 拿到第一个 face，顺序错乱。
 *   现在每个 face 换成 `U+E000 + 序号`，restore **完全无状态**：
 *   任意拆分、任意顺序、重复调用，都能各还原各的。
 *
 * 容量：私用区 U+E000–U+F8FF 共 6400 个，够用（一句话不可能 6400 个表情）。
 */
const MASK_BASE = 0xE000;
const MASK_MAX = 0xF8FF;

/** 匹配一个完整 face：前导符 + 紧跟的 id 字符（id 是**一个** UTF-16 码元）。 */
const FACE_RE = /\u0014[\s\S]/g;

/** 占位符正则（私用区）。 */
const MASK_RE = /[\uE000-\uF8FF]/g;

/**
 * 正文里是否含 face 控制字符。
 * @param {string} text
 * @returns {boolean}
 */
export function hasFace(text) {
  return String(text ?? '').includes(FACE_LEAD);
}

/**
 * 把 face 序列换成**带序号**的占位符。
 *
 * @param {string} text
 * @returns {{ text: string, faces: string[], restore: (s: string) => string }}
 *   faces 按出现顺序记录真表情；restore **无状态**（可对任意片段单独调用）。
 */
export function maskFaces(text) {
  const faces = [];
  const src = String(text ?? '');
  if (!src.includes(FACE_LEAD)) {
    return { text: src, faces, restore: (s) => String(s ?? '') };
  }
  const masked = src.replace(FACE_RE, (m) => {
    const i = faces.length;
    faces.push(m);
    // 超出私用区就不编号了（退化为原字符，极端情况）
    return i <= MASK_MAX - MASK_BASE ? String.fromCharCode(MASK_BASE + i) : m;
  });
  return {
    text: masked,
    faces,
    /**
     * 无状态还原：占位符自带序号，所以对**任意片段、任意顺序、重复调用**都正确。
     * 若某次拆分把占位符丢了，对应 face 也就丢了 —— 可接受的降级
     * （宁可少一个表情，也不要输出裸控制字符）。
     * @param {string} s
     */
    restore: (s) => {
      const out = String(s ?? '');
      if (!out) return out;
      return out.replace(MASK_RE, (ch) => {
        const i = ch.charCodeAt(0) - MASK_BASE;
        return i >= 0 && i < faces.length ? faces[i] : ch;
      });
    },
  };
}

/**
 * 只做「安全化处理」的便捷包装：把 text 掩码后交给 fn，再还原。
 *
 * @template T
 * @param {string} text
 * @param {(masked: string, ctx: { hasFace: boolean }) => T} fn
 * @param {(result: T) => string} [pick] 从结果里取文本（默认要求 fn 返回字符串）
 * @returns {T}
 */
export function withFacesMasked(text, fn, pick) {
  const { text: masked, restore, faces } = maskFaces(text);
  const result = fn(masked, { hasFace: faces.length > 0 });
  if (faces.length === 0) return result;
  if (typeof pick === 'function') return pick(result);
  if (typeof result === 'string') return restore(result);
  return result;
}

/**
 * 按数组还原：用于拆气泡（每个气泡各自还原）。
 *
 * @param {string[]} parts 掩码后的片段
 * @param {(s: string) => string} restore
 * @returns {string[]}
 */
export function restoreEach(parts, restore) {
  return (Array.isArray(parts) ? parts : []).map((p) => restore(p));
}

/**
 * 纯文本长度统计时，让每个 face 计 1 个字符（而不是 0 或 2）。
 * 用于「可见字数」判断，避免含表情的短句被误判成空/过长。
 *
 * @param {string} text
 * @returns {number}
 */
export function faceCount(text) {
  const m = String(text ?? '').match(FACE_RE);
  return m ? m.length : 0;
}

export default {
  FACE_LEAD,
  hasFace,
  maskFaces,
  withFacesMasked,
  restoreEach,
  faceCount,
};
