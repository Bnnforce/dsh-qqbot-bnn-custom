/**
 * roam/core — 纯函数层：解析 / 判定 / 规划（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纪律（照 wake-lottery/core.mjs 的规矩）
 *   · **纯函数**：无 IO、无 Date.now()、无随机源副作用
 *     （now / state / cfg 全部入参）
 *   · **无魔法数字**：所有阈值来自 cfg
 *   · **单一职责**：给一堆输入 → 返回判定结果
 *   · 便于单测：所有分支都能用纯输入触发
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** BV 号格式：BV1 + 9 位字母数字（共 12 字符）。 */
const BV_PATTERN = /^BV1[0-9A-Za-z]{9}$/;

/** av 号格式。 */
const AV_PATTERN = /^av(\d+)$/i;

/** 从 URL 里抓 BV/av 号。 */
const URL_BV = /(BV1[0-9A-Za-z]{9})/;
const URL_AV = /\/video\/av(\d+)/i;

/** 短链域名（无法离线解析，需网络展开 —— 我们不做）。 */
const SHORT_LINK = /b23\.tv\//i;

/** 标题黑名单：这些词出现就大概率是营销号/搬运/合集。 */
const TITLE_BLACKLIST = /营销号|搬运|合集|盘点|排行榜|top\s*\d+|震惊|必看|推荐算法/i;

/**
 * 从任意文本里提取 B站 视频号。
 *
 * 支持 4 种写法：
 *   https://www.bilibili.com/video/BV1xx411c7mD
 *   BV1xx411c7mD                     （裸 BV 号）
 *   https://www.bilibili.com/video/av123456
 *   av123456                         （av 号）
 *
 * ⚠️ 短链 b23.tv 无法离线解析（要发一次 HTTP 拿 302），
 *    这里显式返回 { type:'short' } 让调用方决定要不要展开。
 *
 * @param {string} text
 * @returns {{type:'bvid',id:string}|{type:'av',id:string}|{type:'short',id:string}|null}
 */
export function parseBvid(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;

  // 1) 短链：显式告诉调用方"要联网展开"
  if (SHORT_LINK.test(t)) {
    const m = t.match(/b23\.tv\/([0-9A-Za-z]+)/i);
    return m ? { type: 'short', id: m[1] } : { type: 'short', id: '' };
  }

  // 2) 裸 BV 号
  if (BV_PATTERN.test(t)) return { type: 'bvid', id: t };

  // 3) 裸 av 号
  const av = t.match(AV_PATTERN);
  if (av) return { type: 'av', id: av[1] };

  // 4) URL 里的 BV
  const bvInUrl = t.match(URL_BV);
  if (bvInUrl) return { type: 'bvid', id: bvInUrl[1] };

  // 5) URL 里的 av
  const avInUrl = t.match(URL_AV);
  if (avInUrl) return { type: 'av', id: avInUrl[1] };

  return null;
}

/**
 * 把解析结果转成 API 用的参数。
 *
 * @param {{type:string,id:string}} parsed
 * @returns {{bvid:string}|{aid:string}}
 */
export function toApiParam(parsed) {
  if (!parsed) return {};
  if (parsed.type === 'bvid') return { bvid: parsed.id };
  if (parsed.type === 'av') return { aid: parsed.id };
  return {};
}

/**
 * 判断一个视频"值不值得看"。
 *
 * 判定顺序固定（前面的先否决）：
 *   时长过长 → 时长过短 → 标题像营销号 → 通过
 *
 * @param {{title?:string,duration?:number,play?:number,danmaku?:number,author?:string}} meta
 * @param {object} cfg
 * @returns {{ok:boolean, reason:string}}
 *   reason: 'too-long' | 'too-short' | 'low-quality' | 'ok'
 */
export function isWorthWatching(meta, cfg) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const c = cfg && typeof cfg === 'object' ? cfg : {};

  const duration = Number(m.duration);
  const maxSec = Number.isFinite(c.maxDurationSec) ? c.maxDurationSec : 1800;
  const minSec = Number.isFinite(c.minDurationSec) ? c.minDurationSec : 60;

  // 时长字段缺失时不做时长判定（宁可放行也不误杀）
  if (Number.isFinite(duration) && duration > 0) {
    if (duration > maxSec) return { ok: false, reason: 'too-long' };
    if (duration < minSec) return { ok: false, reason: 'too-short' };
  }

  const title = String(m.title ?? '');
  if (title && TITLE_BLACKLIST.test(title)) return { ok: false, reason: 'low-quality' };

  return { ok: true, reason: 'ok' };
}

/** 取某时间点的小时（按 timezone 口径）。 */
export function hourOf(ms, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Asia/Shanghai',
      hour: 'numeric',
      hour12: false,
    });
    const n = Number(fmt.format(new Date(ms)));
    return Number.isFinite(n) ? (n === 24 ? 0 : n) : 0;
  } catch {
    return 0;
  }
}

/** 取日期键 YYYY-MM-DD（按 timezone 口径）。 */
export function dateKeyOf(ms, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date(ms));
  } catch {
    return '1970-01-01';
  }
}

/**
 * 判断现在是否在装死窗内。
 *
 * 支持跨零点（如 start=22, end=6）。
 *
 * @param {number} hour 0-23
 * @param {{start:number,end:number}} win
 * @returns {boolean}
 */
export function inSleepWindow(hour, win) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const start = Number(win?.start);
  const end = Number(win?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  // 跨零点
  return h >= start || h < end;
}

/**
 * 判断"该不该主动逛一次"。
 *
 * 前置判断顺序固定（前面的先否决）：
 *   disabled → sleep-window → daily-cap → interval → ready
 *
 * @param {{date?:string,dailyProactive?:number,lastProactiveAt?:number}} state
 * @param {object} cfg
 * @param {number} nowMs
 * @returns {{yes:boolean, reason:string}}
 */
export function shouldRoam(state, cfg, nowMs) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const s = state && typeof state === 'object' ? state : {};

  if (c.enabled !== true) return { yes: false, reason: 'disabled' };

  const tz = c.timezone || 'Asia/Shanghai';
  const hour = hourOf(nowMs, tz);
  if (inSleepWindow(hour, c.sleepWindow)) return { yes: false, reason: 'sleep-window' };

  const today = dateKeyOf(nowMs, tz);
  const cap = Number.isFinite(c.dailyProactiveCap) ? c.dailyProactiveCap : 2;
  const used = s.date === today && Number.isFinite(s.dailyProactive) ? s.dailyProactive : 0;
  if (used >= cap) return { yes: false, reason: 'daily-cap' };

  const gap = Number.isFinite(c.roamIntervalMs) ? c.roamIntervalMs : 3 * 3600 * 1000;
  const last = Number.isFinite(s.lastProactiveAt) ? s.lastProactiveAt : 0;
  if (last > 0 && nowMs - last < gap) return { yes: false, reason: 'interval' };

  return { yes: true, reason: 'ready' };
}

/**
 * 判断"能不能响应这个链接"（被动模式限流）。
 *
 * @param {{date?:string,lastResponseAt?:number,byUser?:Record<string,{date:string,count:number}>}} state
 * @param {string} userKey 已 hash 的用户键
 * @param {object} cfg
 * @param {number} nowMs
 * @returns {{yes:boolean, reason:string}}
 */
export function canRespond(state, userKey, cfg, nowMs) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const s = state && typeof state === 'object' ? state : {};

  if (c.enabled !== true) return { yes: false, reason: 'disabled' };

  const tz = c.timezone || 'Asia/Shanghai';
  const today = dateKeyOf(nowMs, tz);

  // 每人每小时
  const perUser = Number.isFinite(c.perUserHourlyCap) ? c.perUserHourlyCap : 3;
  const rec = s.byUser && typeof s.byUser === 'object' ? s.byUser[userKey] : null;
  const userCount = rec && rec.date === today && Number.isFinite(rec.count) ? rec.count : 0;
  if (userCount >= perUser) return { yes: false, reason: 'user-cap' };

  // 每群每小时（用 lastResponseAt 做近似：minInterval 由 ratelimit 层再兜）
  const perGroup = Number.isFinite(c.perGroupHourlyCap) ? c.perGroupHourlyCap : 2;
  const last = Number.isFinite(s.lastResponseAt) ? s.lastResponseAt : 0;
  const hourAgo = nowMs - 3600 * 1000;
  const groupCount = Array.isArray(s._recentResponses)
    ? s._recentResponses.filter((t) => Number.isFinite(t) && t > hourAgo).length
    : 0;
  if (groupCount >= perGroup) return { yes: false, reason: 'group-cap' };

  // 同群 10 分钟冷却（防刷屏）
  if (last > 0 && nowMs - last < 10 * 60 * 1000) return { yes: false, reason: 'cooldown' };

  return { yes: true, reason: 'ready' };
}

/**
 * 规划走哪些通道。
 *
 * ⚠️ 关键：字幕和画面**覆盖率互补**（实测 7/7字幕0画面 ↔ 0/6字幕6画面），
 *    所以默认**两个都试**，不是"失败才换"。
 *
 * @param {object} cfg
 * @param {'auto'|'subtitle'|'frames'} [mode]
 * @returns {{subs:boolean, frames:boolean}}
 */
export function planChannels(cfg, mode) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const m = mode || 'auto';

  if (m === 'subtitle') return { subs: true, frames: false };
  if (m === 'frames') return { subs: false, frames: c.videoshotEnabled === true };

  // auto：字幕必试；画面看配置
  return {
    subs: Number.isFinite(c.subtitleMaxChars) ? c.subtitleMaxChars > 0 : true,
    frames: c.videoshotEnabled === true,
  };
}

/**
 * 截断字幕到上限，保留开头（开头信息量最大）。
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {{text:string, truncated:boolean}}
 */
export function boundText(text, maxChars) {
  const t = String(text ?? '');
  const max = Number.isFinite(maxChars) ? maxChars : 3000;
  if (max <= 0) return { text: '', truncated: t.length > 0 };
  if (t.length <= max) return { text: t, truncated: false };
  return { text: t.slice(0, max), truncated: true };
}

export default {
  parseBvid,
  toApiParam,
  isWorthWatching,
  hourOf,
  dateKeyOf,
  inSleepWindow,
  shouldRoam,
  canRespond,
  planChannels,
  boundText,
  BV_PATTERN,
  TITLE_BLACKLIST,
};
