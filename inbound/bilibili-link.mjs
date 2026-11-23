/**
 * bilibili-link — 识别群里的 B站 链接（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 官方契约铁律：入站是热路径
 *   extension-contract.md 明确：入站**不要**发消息、打接口、做长任务。
 *   所以这里**只做一件事**：识别到 B站 链接 → 打标记 → 立即放行。
 *
 *   真正的抓取在 tools/bili_watch.mjs 里做（她自己去调）。
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 *   群友发个链接，她得"知道"有人发了视频，才可能去用 bili_watch。
 *   这里就是那个"知道"。
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 2026-11-23 修（R-04）：导出形态改成官方**早挂点** `onInbound(ctx, next)`
 *
 *   原来导出的是 `run(msg, env)`（照搬 tools 的壳）。插件的
 *   `dist/features/ext-inbound.js` `normalizeInbound()` 只认这一组候选：
 *     raw.onInbound / default.onInbound / raw.onDecide / default(裸函数) /
 *     default.onDecide / default.middleware / raw.middleware
 *   `run` 不在里面 ⇒ 每次启动都被 `logger.warn` + 跳过（不报错、不崩、静默失效），
 *   于是「〔B站:BVxxx〕」标记从未真正写进过任何消息，R5.7 的被动响应链路永远走不到。
 *
 *   早挂点契约（逐条对齐，别改）：
 *     · 文本 = `ctx.message.content`；群号 = `ctx.message.groupOpenid`；发送者 = `ctx.message.senderId`
 *     · 改文本 **只能** `ctx.rewrite({ text, reason })` —— **传对象，不是传字符串**
 *       （ext-inbound-context.js `rewrite()` 只认 `opts.text`；传字符串会被拒 + warn）
 *     · **必须 `await next()`** —— 不调 next 是"消灭这条消息"，那是另一个语义
 *     · **绝不能抛** —— 抛错引擎虽会兜住，但自己的逻辑会中断
 *     · 早挂点读不到 `ctx.state.mention`（那是晚挂点才写的）；
 *       真要判"有没有@"只能用 `ctx.platform.mentioned`（本文件**不判** @，见下）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { parseBvid } from '../lib/roam/core.mjs';
import { resolveConfig } from '../lib/roam/config.mjs';

export const name = 'bilibili-link';

/** 已经提示过的 bvid（防同一链接反复提示）。 */
const hinted = new Map();

/** 提示记录保留时长。 */
const HINT_TTL_MS = 30 * 60 * 1000;

/**
 * 配置缓存保留时长（5 秒）。
 *
 * 为什么需要：`resolveConfig()` 每次调用都 `readFileSync` 一次 `roam-config.json`
 * （lib/roam/config.mjs:218，已确认**无缓存**），而这里是**每条入站消息**都过的热路径。
 * 为什么是 5 秒 TTL 而不是"启动读一次"：改配置不该要求重启，最多 5 秒自然生效。
 */
const CFG_TTL_MS = 5 * 1000;

/** 配置缓存槽：`{ at, cfg }`；null = 还没读过。 */
let cfgCache = null;

/**
 * 取配置（模块级 5 秒 TTL 缓存）。
 *
 * @returns {object|null} 配置；读配置这一步出意外时返回 null（＝这条不提示，但照常放行）
 */
function readConfigCached() {
  const now = Date.now();
  if (cfgCache && now - cfgCache.at < CFG_TTL_MS) return cfgCache.cfg;
  try {
    const cfg = resolveConfig();
    cfgCache = { at: now, cfg };
    return cfg;
  } catch {
    // 配置读取出意外：不缓存（下条重试），本条当作"禁用"处理
    return null;
  }
}

/**
 * 从消息文本里找 B站 链接。
 *
 * @param {string} text
 * @returns {{type:string,id:string}|null}
 */
function findLink(text) {
  const t = String(text || '');
  // 只认带域名的写法，避免把裸 "BV1xx" 也拦下来（群友聊个 BV 号不该触发）
  if (!/bilibili\.com|b23\.tv/i.test(t)) return null;
  return parseBvid(t);
}

/**
 * 读这条消息的当前文本。
 *
 * 权威来源是 `ctx.message.content`（`rewrite` 内部改的就是这个字段）；
 * 拿不到时回落到 `ctx.text`（官方 getter，或测试桩上的普通字段）。
 *
 * @param {object} ctx
 * @returns {string}
 */
function readText(ctx) {
  const content = ctx?.message?.content;
  if (typeof content === 'string') return content;
  try {
    const t = ctx?.text;
    return typeof t === 'string' ? t : String(t ?? '');
  } catch {
    return '';
  }
}

/**
 * 取去重用的"会话标识"。
 *
 * 群聊 = 群号（等价于旧契约的 `msg.groupId`）；
 * 私聊没有 groupOpenid，用 senderId（等价于旧契约的 `msg.peerId`）。
 *
 * @param {object} ctx
 * @returns {string}
 */
function peerOf(ctx) {
  try {
    const g = String(ctx?.message?.groupOpenid ?? '') || String(ctx?.groupId ?? '');
    if (g) return g;
    return String(ctx?.message?.senderId ?? '');
  } catch {
    return '';
  }
}

/**
 * 把改后的文本写回这条消息。
 *
 * ⚠️ 官方契约是 `ctx.rewrite({ text, reason })` —— **传对象，不是传字符串**。
 *    （ext-inbound-context.js `rewrite(ctx, s, opts)` 只认 `opts.text`；
 *      传字符串会 warn「rewrite 需要 { text: "改写后的文本" }」并拒绝。）
 *    它内部 try/catch，任何情况下都不抛，返回 true/false。
 *
 * 兜底策略：**以落点字段为准**，不信返回值。
 *    官方 `rewrite()` 成功时的动作就是 `ctx.message.content = opts.text`，
 *    所以「`ctx.message.content` 是否真的变成了目标文本」是比返回值更硬的判据 ——
 *    宿主没提供 `rewrite`、返回 false 被拒、或实现是个空壳（返回 undefined 却没写），
 *    三种情况都能被这一条接住。
 *    直写 `ctx.message.content` 与 `rewrite` 的落点是**同一个字段**，效果等价；
 *    早挂点跑在**记群历史之前**，所以群历史里也是改后的文本。
 *
 * @param {object} ctx
 * @param {string} text
 * @returns {boolean} 是否写成功
 */
function applyRewrite(ctx, text) {
  try {
    if (typeof ctx?.rewrite === 'function') {
      ctx.rewrite({ text, reason: '识别到B站链接' });
      // 成功判据看落点，不看返回值（见上）
      if (ctx?.message?.content === text) return true;
    }
  } catch {
    // 契约保证不抛，但入站热路径绝不冒险；落到下面的直写兜底
  }
  try {
    if (ctx && typeof ctx === 'object' && ctx.message && typeof ctx.message === 'object') {
      ctx.message.content = text;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 识别 + 去重 + 打标记（全部逻辑，异常由调用方兜住）。
 *
 * @param {object} ctx
 */
function maybeHint(ctx) {
  const cfg = readConfigCached();
  if (!cfg?.enabled) return;

  const text = readText(ctx);
  if (!text) return;

  const hit = findLink(text);
  if (!hit) return;

  // 短链没法离线解析，不提示
  if (hit.type === 'short') return;

  const key = peerOf(ctx) + '|' + hit.id;
  const now = Date.now();
  const last = hinted.get(key) || 0;
  if (now - last < HINT_TTL_MS) return;   // 30 分钟内提示过
  hinted.set(key, now);

  // 清理过期记录（防内存涨）
  // ⚠️ 2026-11-23 加固：超过 500 条才清是「懒清理」，
  //   极端情况下（大量不同链接）可能短暂涨到 500+。加硬上限兜底。
  if (hinted.size > 2000) hinted.clear();
  if (hinted.size > 500) {
    for (const [k, t] of hinted) {
      if (now - t > HINT_TTL_MS) hinted.delete(k);
    }
  }

  // 只加一行极简提示，不改原文、不调接口
  // ⚠️ 2026-11-23 打磨：原来标记写成「[群里有人发了 B站 视频 BV...，想看就用 bili_watch]」
  //   太像给人看的提示语，有被她复读出来的风险。改成极简的角标形式。
  const marker = '〔B站:' + hit.id + '〕';
  applyRewrite(ctx, text + String.fromCharCode(10) + marker);
}

/**
 * 官方早挂点：每条入站消息都过一遍（quoteRef 之后、记群历史之前）。
 *
 * ⚠️ 三条铁律：
 *   ① 自己的逻辑一律包 try —— 入站绝不能抛（出错＝这条当没识别到，原样放行）；
 *   ② **一定调 `next()`** —— 不调就是不消灭这条消息，那是另一个语义；
 *   ③ `next()` 放在 try 外面 —— 下游自己的异常原样上抛，由引擎分辨归属，
 *      别把别人的错吞成"扩展坏了"。
 *
 * 为什么**不**判 `ctx.platform.mentioned`（有没有 @ 她）：
 *   R5.7 的语义是"群里任何人发 B站 链接，她就有机会知道"，与是否 @ 她无关。
 *   加上 @ 判断会收窄触发面，让这条链路更容易失效；所以保持原逻辑不判 @。
 *
 * @param {object} ctx
 * @param {() => Promise<any>} next
 */
export async function onInbound(ctx, next) {
  try {
    maybeHint(ctx);
  } catch {
    // 入站绝不能抛
  }
  return next();
}

export function dispose() {
  hinted.clear();
  cfgCache = null;
}

export default { name, onInbound, dispose };
