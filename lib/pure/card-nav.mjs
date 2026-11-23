/**
 * card-nav — 卡片底部「功能按钮」层（2026-11-09）
 *
 * 主人要求：每张玩法卡片下面加一行功能按钮（日历 / 骰子 / 抽签 / 来张图），
 *   点它 = **调用那个功能的现有实现**，但**不放自己那一项**（自己跳自己没意义）。
 *
 * ⚠️ 为什么必须抽成一层、而不是每个模块各写一份：
 *   ① 按钮 id 前缀、要调的 botplay 事件 id、@ 口径，四个模块必须完全一致；
 *   ② 一旦以后加功能（比如猜拳重新进列表），只改 NAV_ITEMS 一处；
 *   ③ 测试可以对**纯函数** navButtons/parseNav 直接断言，不需要起宿主。
 *
 * ── 为什么点击后是「另发一张卡」而不是「就地变形」────────────���───────────────
 *   botplay 的点击分发是**按发卡时登记的 extFile** 走的（`runExtClick`）：
 *   抽签卡就算把按钮换成骰子的，再点「再来一次」仍然回调 fortune.mjs —— 就地变形必须
 *   额外维护"当前模式"并在每个模块里二次分发，状态（猜拳盲注/抽签种子）也会互相污染。
 *   另发一张卡的语义最干净：跟斜杠 `/骰子` 完全一致，各功能状态各自独立。
 *
 * ── 四个功能**全部**是真卡片 ─────────────────────────────────────────────
 *   2026-11-09 修正：日历最初被做成"发一条 markdown 文本"（当初判断它没有卡片形态），
 *   结果是 —— 从骰子卡点「📅 日历」跳过去之后，**日历那段消息没有任何按钮**，
 *   想再去抽签就得重新发卡片。主人当场指出「日历卡片中没有别的功能按钮」。
 *   → 现在日历也是 botplay 事件卡片（botplay/calendar.mjs），四项完全对称，
 *     从任何一张卡都能一路点到任何另一个功能。
 */

/** 按钮 id 前缀（与各模块自己的按钮 id 天然不冲突：again / rock / pair…） */
export const NAV_PREFIX = 'nav:';

/**
 * 功能按钮表（顺序 = 主人给的顺序，去掉猜拳后：日历、骰子、抽签、来张图）。
 *
 * `self` 是"这张卡自己属于哪个功能"，用来在渲染时剔除自己那一项。
 *
 * ⚠️ 2026-11-09 修正：日历原来 `eventId: null`（= 发一条 markdown 文本），
 *   结果从别的卡片点「📅 日历」之后，就**停在一段没有任何按钮的消息上**，回不去了。
 *   主人当场反馈「日历卡片中没有别的功能按钮」。
 *   → 现在日历也是真正的 botplay 事件卡片（botplay/calendar.mjs），四项统一走 trigger。
 */
export const NAV_ITEMS = [
  { key: 'calendar', label: '📅 日历', self: 'calendar', eventId: 'calendar' },
  { key: 'dice', label: '🎲 骰子', self: 'dice', eventId: 'dice' },
  { key: 'fortune', label: '🎴 抽签', self: 'fortune', eventId: 'fortune' },
  { key: 'image', label: '🖼 来张图', self: 'image', eventId: 'random-image' },
];

/**
 * 生成某张卡底部的功能按钮（**不含自己**）。
 *
 * @param selfKey 当前卡片的功能标识（dice / fortune / image / rps …）
 *                不在 NAV_ITEMS 里（比如 rps）→ 四项全给
 * @returns botplay 按钮数组；style=0 次要按钮，跟主操作区分开
 */
export function navButtons(selfKey = '') {
  const self = String(selfKey ?? '').trim();
  return NAV_ITEMS
    .filter((it) => it.self !== self)
    .map((it) => ({
      id: `${NAV_PREFIX}${it.key}`,
      label: it.label,
      style: 0,
      botAction: { type: 'reply_text', text: '' },
    }));
}

/**
 * 解析功能按钮 id。
 *
 * @returns NAV_ITEMS 里的那一项；不是功能按钮 / 未知 key → null
 */
export function parseNav(buttonId) {
  const id = String(buttonId ?? '');
  if (!id.startsWith(NAV_PREFIX)) return null;
  const key = id.slice(NAV_PREFIX.length);
  return NAV_ITEMS.find((it) => it.key === key) ?? null;
}

// ─────────────────────── 运行时：真正把功能调起来 ───────────────────────

/** 插件 dist 模块走统一解析入口（见 lib/plugin-dist.mjs 的技术债说明） */
async function loadTrigger() {
  try {
    const { importPluginModule } = await import('../io/plugin-dist.mjs');
    const m = await importPluginModule('features/botplay.js');
    return m && typeof m.triggerBotplay === 'function' ? m.triggerBotplay : null;
  } catch { return null; }
}

/** 取本实例 settingsNs（多账号时决定"由哪个实例发卡"） */
async function resolveNs(ctx) {
  // ① 插件内核里直接有 manager（最可靠）
  try {
    const m = ctx?.kernel?.get?.('qqChannel')?.manager;
    const ns = String(m?.settingsNs ?? '').trim();
    if (ns) return ns;
  } catch { /* fallback */ }
  // ② 会话注册表按 scope+peerId 反查
  try {
    const e = ctx?.event ?? {};
    const scope = String(e.scope || '');
    const peerId = String(e.peerId || '');
    // 走统一解析入口（原来是手写 registryCandidates + file:// 拼串）
    const { importPluginModule } = await import('../io/plugin-dist.mjs');
    const reg = await importPluginModule('features/session-registry.js');
    const m = scope && peerId ? reg?.findManagerByPeer?.(scope, peerId) : null;
    const ns = String(m?.settingsNs ?? '').trim();
    if (ns) return ns;
  } catch { /* ignore */ }
  // ③ 兜底：当前只挂了一个实例，triggerImpls 里的单例回落也能命中
  return 'im-qqbot-2';
}

/** 卡片上下文 → ReplyTarget（发新卡片用） */
function targetOf(ctx) {
  const e = ctx?.event ?? {};
  return {
    scope: String(e.scope || '') === 'group' ? 'group' : 'c2c',
    targetId: String(e.peerId || ''),
  };
}

/**
 * 执行一次功能按钮点击。
 *
 * 返回值语义（与模块 onClick 直接对接）：
 *   ''    → 成功，**不再额外发消息**（卡片已经发出去了）
 *   非空串 → 给点击者的一句 plain text 提示（失败原因）
 *
 * @param ctx  botplay 卡片上下文
 * @param item parseNav() 的结果
 * @param opts 测试注入口：{ trigger, ns, target }
 */
export async function runNav(ctx, item, opts = {}) {
  if (!item || !item.key) return '未知的功能按钮。';

  // ── 统一走 botplay 事件：日历/骰子/抽签/来张图 都是真卡片 ──
  const eventId = item.eventId;
  if (!eventId) return '这个功能还没接线。';
  try {
    const trigger = opts.trigger ?? (await loadTrigger());
    if (typeof trigger !== 'function') return '事件系统未就绪，请重启 DSH 后再试。';
    const ns = opts.ns ?? (await resolveNs(ctx));
    const target = opts.target ?? targetOf(ctx);
    if (!target.targetId) return '拿不到当前会话，稍后再试。';
    const uid = String(ctx?.user?.openid ?? '');
    const r = await trigger(ns, target, eventId, uid);
    if (r?.ok) return '';
    return r?.msg || `「${item.label}」打开失败了，稍后再试。`;
  } catch (e) {
    return `「${item.label}」打开失败：${e?.message ?? e}`;
  }
}

/**
 * 模块 onClick 一行接入：命中功能按钮就执行并告诉调用方"已处理"。
 *
 * @returns undefined = 不是功能按钮（调用方继续走自己的逻辑）
 *          字符串    = 已处理，直接把它当 onClick 的返回值返回
 */
export async function handleNavClick(ctx, buttonId, opts = {}) {
  const item = parseNav(buttonId);
  if (!item) return undefined;
  return await runNav(ctx, item, opts);
}
