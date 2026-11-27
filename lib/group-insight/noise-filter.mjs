/**
 * noise-filter — 群聊消息噪声过滤（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块（实测数据）：
 *
 *   全量 2890 条消息中，有 27 条（0.93%）是 QQ 系统占位消息：
 *     · 「暂不能查看该消息内容」 21 条
 *     · 「[群聊的聊天记录] === 消息 1 === ...」 6 条
 *
 *   0.93% 听起来很少，但滑动窗口会把它放大几百倍：
 *     「暂不能查看该消息内容」11 个字
 *       → 切出 暂不/不能/能查/查看/看该/该消/消息/息内/内容 + 各种三字四字组合
 *       → 21 条 × 几十个子串 = 几百次重复计数
 *     ⇒ 「消息」「内容」「消息内容」霸占词频第一，真实话题被完全淹没
 *
 *   实测证据：138 条消息跑 harvest，提取 0 个候选（全被噪声占了）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 设计原则：
 *   ① **过滤内容，但记录数量** —— 噪声本身是「群活跃度」的信号
 *   ② **转发记录提取真实内容** —— 转发里其实有人在说话
 *   ③ **纯函数** —— 可单测，无 IO
 */

/** 明确的系统占位文本（整条丢弃）。 */
export const NOISE_PATTERNS = Object.freeze([
  '暂不能查看该消息内容',
  '暂不能查看',
  '该消息内容无法查看',
  '消息已过期',
  '消息已撤回',
]);

/** 合并转发的标记（不丢弃，提取内容）。 */
export const FORWARD_MARKERS = Object.freeze([
  '[群聊的聊天记录]',
  '=== 消息',
]);

/**
 * 是否是系统噪声（纯函数）。
 *
 * @param {{x?:string, k?:string}} msg
 * @returns {boolean}
 */
export function isNoise(msg) {
  const t = String(msg?.x ?? '').trim();
  if (!t) return true;                                   // 空消息
  return NOISE_PATTERNS.some((p) => t.includes(p));
}

/**
 * 是否是合并转发（需要提取内容而非丢弃）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isForward(text) {
  const t = String(text ?? '');
  return FORWARD_MARKERS.some((p) => t.includes(p));
}

/**
 * 从合并转发记录里提取真实消息内容（纯函数）。
 *
 * 格式示例：
 *   `[群聊的聊天记录] === 消息 1 === [发送者] 愚度 [消息内容] 鬼脑又发动了`
 *
 * @param {string} text
 * @returns {string} 提取到的内容（多条用空格连接），失败返回空串
 */
export function extractFromForward(text) {
  const t = String(text ?? '');
  if (!isForward(t)) return '';

  const out = [];
  // 匹配 [消息内容] 后面的文本，直到下一个 === 或结尾
  const re = /\[消息内容\]\s*([^[]+?)(?=\s*(?:===|\[发送者\]|$))/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const v = String(m[1] ?? '').trim();
    if (v) out.push(v);
  }

  // 如果没有 [消息内容] 标记，尝试去掉所有标记后取剩余
  if (!out.length) {
    const cleaned = t
      .replace(/\[群聊的聊天记录\]/g, '')
      .replace(/=== 消息 \d+ ===/g, '')
      .replace(/\[发送者\][^\[]*/g, '')
      .replace(/\[附件\d+\]/g, '')
      .replace(/\[消息内容\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && cleaned.length > 2) out.push(cleaned);
  }

  return out.join(' ').trim();
}

/**
 * 清洗消息列表（核心函数）。
 *
 * @param {Array<{s?:string, n?:string, t?:number, k?:string, x?:string}>} messages
 * @param {{stats?:boolean}} [opts]
 * @returns {{clean:Array<object>, stats:object}}
 */
export function cleanMessages(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const clean = [];
  const stats = {
    total: list.length,
    noise: 0,        // 系统占位（丢弃）
    forward: 0,      // 合并转发（提取内容）
    empty: 0,        // 空消息
    kept: 0,         // 保留
  };

  for (const m of list) {
    const raw = String(m?.x ?? '').trim();

    // ① 空消息
    if (!raw) { stats.empty += 1; continue; }

    // ② 系统占位 → 丢弃（但计数）
    if (isNoise(m)) { stats.noise += 1; continue; }

    // ③ 合并转发 → 提取内容
    if (isForward(raw)) {
      stats.forward += 1;
      const extracted = extractFromForward(raw);
      if (!extracted) continue;
      clean.push({ ...m, x: extracted, _fromForward: true });
      stats.kept += 1;
      continue;
    }

    // ④ 正常消息
    clean.push(m);
    stats.kept += 1;
  }

  if (opts.stats === false) return { clean, stats };
  return { clean, stats };
}

export default {
  NOISE_PATTERNS, FORWARD_MARKERS,
  isNoise, isForward, extractFromForward, cleanMessages,
};
