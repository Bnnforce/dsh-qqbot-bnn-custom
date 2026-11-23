/**
 * points/format — 积分提示的统一排版（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个：
 *
 *   之前每个卡片各写各的积分提示，格式散乱：
 *     抽签：「🌟 手气奖励：+4　余额：12」
 *     猜拳：「🎯 本局积分：+2 / 💎 当前余额：2」
 *     骰子：「🎲 获得积分：+1 / 💎 当前余额：1」
 *
 *   同一件事三种写法 —— 这就是不工业化。本模块给出唯一格式。
 *
 * ── 统一格式 ────────────────────────────────────────────────────────────────
 *   第 1 行：<图标> <标签> <增减>　·　余额 <余额>
 *   第 2 行：📅 今日额度 <已用>/<上限>            （有额度限制时才有）
 *   第 3 行起：额外说明（如"连续签到 3 天"）
 *
 *   产出示例：
 *     🎯 本局 **+2** 积分　·　余额 **12**
 *     📅 今日额度 **1/5**
 *
 *     🌟 抽签 **+4** 积分　·　余额 **12**
 *
 *     💰 签到 **+5** 积分　·　余额 **12**
 *     🔥 连续 **3** 天
 *
 * ── 设计要点 ────────────────────────────────────────────────────────────────
 *   · 数字一律加粗（一眼能看到变化）
 *   · 负号用全角「−」而不是半角「-」（对齐更好看）
 *   · 额度写成「已用/上限」而不是「还剩 N 次」（信息更完整）
 *   · 额度满时明确标「已满」，避免用户以为是 bug
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 各场景的图标（统一管理，改一处全改）。 */
const ICONS = {
  checkin: '💰',
  fortune: '🌟',
  rps: '🎯',
  dice: '🎲',
  shop: '🏪',
  default: '💎',
};

/**
 * 把增减值格式化成带符号的字符串。
 * @param {number} delta
 * @returns {string} 如「+2」「0」「−1」
 */
export function formatDelta(delta) {
  const d = Math.floor(Number(delta) || 0);
  if (d > 0) return `+${d}`;
  if (d < 0) return `−${Math.abs(d)}`;   // 全角负号，对齐好看
  return '0';
}

/**
 * 生成积分提示块（多行字符串，不带前置空行）。
 *
 * @param {{
 *   kind?: 'checkin'|'fortune'|'rps'|'dice'|'shop',
 *   label?: string,      // 覆盖默认标签（如「本局」）
 *   delta: number,       // 本次增减
 *   balance: number,     // 当前余额
 *   left?: number,       // 今日剩余次数（有额度限制时传）
 *   cap?: number,        // 今日额度上限
 *   extra?: string[],    // 额外行
 * }} p
 * @returns {string}
 */
export function formatPointsBlock(p) {
  const icon = ICONS[p.kind] || ICONS.default;
  const label = p.label || defaultLabel(p.kind);
  const delta = formatDelta(p.delta);
  const balance = Math.max(0, Math.floor(Number(p.balance) || 0));

  // 第一行明确写「积分」，避免「本次 +1」看不出是什么东西
  const lines = [`${icon} ${label} **${delta}** 积分　·　余额 **${balance}**`];

  // 额度行（只有传了 left 才显示）
  if (Number.isFinite(Number(p.left))) {
    const cap = Number(p.cap) > 0 ? Number(p.cap) : 5;
    const left = Math.max(0, Math.floor(Number(p.left)));
    const used = Math.max(0, cap - left);
    lines.push(left > 0
      ? `📅 今日额度 **${used}/${cap}**`
      : `📅 今日额度 **${cap}/${cap}**　已满`);
  }

  // 额外行
  for (const e of Array.isArray(p.extra) ? p.extra : []) {
    const t = String(e ?? '').trim();
    if (t) lines.push(t);
  }

  return lines.join('\n');
}

/** 各 kind 的默认标签。 */
function defaultLabel(kind) {
  switch (kind) {
    case 'checkin': return '签到';
    case 'fortune': return '抽签';
    case 'rps': return '本局';
    case 'dice': return '本次';
    case 'shop': return '消费';
    default: return '本次';
  }
}

/**
 * 前置空行版本（拼到卡片正文后面时用）。
 * @param {object} p 同 formatPointsBlock
 * @returns {string} 形如 `\n\n🎯 ...`
 */
export function appendPointsBlock(p) {
  const block = formatPointsBlock(p);
  return block ? `\n\n${block}` : '';
}

/**
 * 「今天拿满了」的统一提示。
 * @param {string} [what] 玩法名
 */
export function pointsCappedLine(what = '这个玩法') {
  return `📅 ${what}今日额度 **已满**`;
}