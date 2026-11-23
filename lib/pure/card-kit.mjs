/**
 * card-kit — botplay 卡片的统一工具层（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个模块（架构审计结论，见 Bot/维护/卡片架构审计-20261117.md）：
 *
 *   审计发现 9 个卡片各有各的写法：
 *     · 配置读取写了 4 遍（dice/fortune/pairing/random-image 各一套）
 *     · 卡片触发写了 2 遍（骰子/小店各一套 loadBotplay + triggerBotplay）
 *     · 取群号有 2 种口径（ctx.event.peerId vs ctx.caps.peerId）—— 踩过坑
 *
 *   本模块把所有"每张卡片都要做一遍"的事集中到一处。
 *   目标：新卡片只写业务，不写管道。
 *
 * ── 官方契约依据 ─────────────────────────────────────────────────────────────
 *   docs/botplay-contract.md：
 *     · 卡片上下文：ctx.event.peerId / ctx.user.{openid,name,isOwner}
 *     · 命令上下文：ctx.caps.peerId / ctx.caps.actorOpenid / ctx.message.groupOpenid
 *     两种上下文字段**不同**，本模块各给一个函数，别再混。
 *
 * ── 铁律 ────────────────────────────────────────────────────────────────────
 *   · 所有函数**永不抛**（失败返回安全默认值 / false / 空）
 *   · 不 import 任何宿主内部模块到顶层（用动态 import，避免加载顺序问题）
 *   · 本文件属于运行树 lib/pure/，扩展包侧引用请用绝对路径或复制同步
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** QQ 群 openid 形状（32 位十六进制）。 */
const GID_RE = /^[0-9A-Fa-f]{32}$/;

// ─────────────────────────────────────────────────────────────────────────
// 一、上下文取值（两种上下文各一个函数，别混用）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从**卡片上下文**取群 id。
 * 契约：ctx.event.peerId
 * @returns {string} 合法 gid，或 ''（拿不到）
 */
export function cardGroupId(ctx) {
  try {
    const id = String(ctx?.event?.peerId || '');
    return GID_RE.test(id) ? id : '';
  } catch { return ''; }
}

/**
 * 从**卡片上下文**取点击人。
 * 契约：ctx.user = { openid, name, pureName, isOwner }
 * @returns {{openid:string, name:string, isOwner:boolean}}
 */
export function cardUser(ctx) {
  try {
    return {
      openid: String(ctx?.user?.openid || ''),
      name: String(ctx?.user?.name || ctx?.user?.pureName || ''),
      isOwner: ctx?.user?.isOwner === true,
    };
  } catch {
    return { openid: '', name: '', isOwner: false };
  }
}

/**
 * 从**命令上下文**取群 id 与说话人。
 * 契约：ctx.caps.peerId / ctx.caps.actorOpenid / ctx.message.*
 *
 * ⚠️ 2026-11-17 踩坑：命令上下文**没有** ctx.event.peerId，
 *    用错字段会报"只能在群里用"。
 * @returns {{gid:string, uid:string}}
 */
export function commandPeer(ctx) {
  try {
    const caps = ctx?.caps ?? {};
    const mc = ctx?.message ?? {};
    const gid = String(
      caps.peerId ?? mc.groupOpenid ?? mc.group_openid
      ?? ctx?.event?.peerId ?? '',
    );
    const uid = String(
      caps.actorOpenid ?? mc.author?.member_openid ?? mc.author?.user_openid
      ?? ctx?.user?.openid ?? '',
    );
    return { gid: GID_RE.test(gid) ? gid : '', uid };
  } catch {
    return { gid: '', uid: '' };
  }
}

/** 命令上下文的 settingsNs（多账号实例区分用）。 */
export function settingsNsOf(ctx) {
  try {
    return String(
      ctx?.caps?.settingsNs ?? ctx?.settingsNs ?? ctx?.config?.settingsNs ?? 'im-qqbot-2',
    ).trim() || 'im-qqbot-2';
  } catch { return 'im-qqbot-2'; }
}

/** 数据根（命令上下文里能拿到；卡片上下文拿不到）。 */
export function dataRootOfCmd(ctx) {
  try {
    const p = String(ctx?.caps?.dataRoot ?? ctx?.dataRoot ?? '').trim();
    if (p) return p;
  } catch { /* ignore */ }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────
// 二、卡片写入（统一 setCard，避免各写各的）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 设置卡片正文与按钮。
 *
 * ⚠️ 官方铁律：**只有真要刷新按钮状态才设 dirty**（刷屏 + 撞发卡限频）。
 *    本函数默认**不置 dirty**，需要刷新时显式传 dirty:true 或调用 markDirty。
 *
 * @param {object} ctx
 * @param {string} text 正文
 * @param {Array} buttons 按钮
 * @param {{dirty?:boolean}} opts
 */
export function setCard(ctx, text, buttons = [], opts = {}) {
  try {
    const c = ctx.card();
    if (text !== undefined) c.contentText = text;
    if (Array.isArray(buttons)) c.buttons = buttons;
    if (opts.dirty === true) c.dirty = true;
    return c;
  } catch { return null; }
}

/** 显式刷新（按钮/正文变了才调）。 */
export function markDirty(ctx) {
  try { ctx.card().dirty = true; } catch { /* ignore */ }
}

/** 构造一个普通按钮（reply_text 类型）。 */
export function btn(id, label, style = 1) {
  return { id: String(id), label: String(label), style, botAction: { type: 'reply_text', text: '' } };
}

// ─────────────────────────────────────────────────────────────────────────
// 三、配置读取（统一 + 缓存）
// ─────────────────────────────────────────────────────────────────────────

/** 配置缓存：`${root}:${file}` → { mtimeMs, value }。 */
const CFG_CACHE = new Map();

/**
 * 读一个 JSON 配置文件（带 mtime 缓存）。
 *
 * 用途：替换 dice/fortune/pairing/random-image 里各写一遍的 readFileSync。
 *
 * @param {string} root 数据根（不含 .qqbot-extensions）
 * @param {string} rel  相对路径，如 'data/game-config.json'
 * @param {object} fallback 读失败时的默认值
 * @returns {object} 解析结果或 fallback
 */
export function loadJsonConfig(root, rel, fallback = {}) {
  const r = String(root || '').trim();
  if (!r) return fallback;
  const file = join(r, '.qqbot-extensions', rel);
  try {
    const st = statSyncSafe(file);
    const key = `${file}`;
    const hit = CFG_CACHE.get(key);
    if (hit && st !== null && hit.mtimeMs === st) return hit.value;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (st !== null) CFG_CACHE.set(key, { mtimeMs: st, value });
    return value;
  } catch {
    return fallback;
  }
}

/** statSync 的安全包装（只取 mtimeMs）。 */
function statSyncSafe(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** 清缓存（配置热更时用；一般不用手动调，mtime 变了会自动失效）。 */
export function clearConfigCache() {
  CFG_CACHE.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// 四、卡片触发（统一 fireCard，命令侧用）
// ─────────────────────────────────────────────────────────────────────────

/** 插件内部 botplay 模块的加载器（动态，只加载一次）。 */
let _botplayMod = null;

/**
 * 加载插件内部的 features/botplay.js。
 * 照 `commands/骰子.mjs` 的已验证做法。
 */
async function loadBotplay() {
  if (_botplayMod) return _botplayMod;
  const { importPluginModule } = await import('../io/plugin-dist.mjs');
  _botplayMod = await importPluginModule('features/botplay.js');
  return _botplayMod;
}

/**
 * 在**命令上下文**里触发一张 botplay 卡片。
 *
 * 用途：让任意斜杠命令都能直接弹卡片（不用让用户记 /botplay <id>）。
 *
 * @param {object} ctx 命令上下文
 * @param {string} eventId botplay 事件 id
 * @returns {Promise<boolean>} 是否成功发出
 */
export async function fireCard(ctx, eventId) {
  try {
    const M = await loadBotplay();
    if (!M?.triggerBotplay || !M?.resolveCommandTarget) return false;
    const { target, triggererId } = M.resolveCommandTarget(ctx);
    if (!target?.targetId || !triggererId) return false;
    const r = await M.triggerBotplay(settingsNsOf(ctx), target, eventId, triggererId);
    return r?.ok === true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 五、卡片命令工厂（每个卡片 5 行就能有专属斜杠命令）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 生成一个"打开某卡片"的斜杠命令。
 *
 * @param {{id:string, names:string[], description:string, usage?:string}} p
 * @returns {object} 命令模块的 default 导出
 *
 * 例：
 *   export default cardCommand({
 *     id: 'calendar',
 *     names: ['日历', 'calendar', 'rili'],
 *     description: '看今天的日历',
 *   });
 */
export function cardCommand(p) {
  const id = String(p?.id || '').trim();
  const names = Array.isArray(p?.names) && p.names.length > 0 ? p.names.map(String) : [id];
  return {
    name: names,
    description: String(p?.description || `打开「${id}」卡片`),
    usage: String(p?.usage || `/${names[0]}`),
    async handler(ctx) {
      if (!id) return '这个卡片还没配 id。';
      const ok = await fireCard(ctx, id);
      if (ok) return '';   // 卡片已发出，不再回文本
      return `卡片没打开，试试 /botplay ${id}`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 六、通用安全包装
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把 handler 包一层 try-catch（卡片报错不能把整个 botplay 弄崩）。
 *
 * @param {(ctx, info) => Promise<any>} fn
 * @param {string} label 日志标签
 */
export function safeHandler(fn, label = 'card') {
  return async (ctx, info) => {
    try {
      return await fn(ctx, info);
    } catch (e) {
      try { ctx?.log?.(`[${label}] ${e instanceof Error ? e.message : String(e)}`); } catch { /* ignore */ }
      return '';
    }
  };
}