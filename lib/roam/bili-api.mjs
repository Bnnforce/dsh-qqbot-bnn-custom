/**
 * roam/bili-api — B站 官方 API 封装（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么不直接 import 插件
 *   实测：扩展包没有自己的 node_modules 链，import 'dsh-plugin-bilibili' 会失败。
 *   所以自研一份，与插件**完全解耦**（插件更新不破坏我们）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 实测结论（2026-11-22，全部真机验证过）
 *   · 裸 fetch 搜「搜索接口」→ 返回 HTML 错误页（被拦）
 *     ⇒ 搜索**必须**走插件的 bilibili_search 工具
 *   · 但 view / player / videoshot 自己调**能通**（带正确 UA+Referer+Cookie）
 *   · WBI 签名自研可行 → 字幕 8 轨、1503 cue 全拿到
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 红线
 *   · cookie 只在请求时从环境变量读，**绝不进日志、绝不写盘**
 *   · 拒绝重定向（redirect:'manual'）—— 防凭据被转发
 *   · 字幕/图片 CDN 请求**不带 cookie**（插件同款做法）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sign as wbiSign, signWithKeys, extractWbiKeys } from './wbi.mjs';
import { withBackoff } from './ratelimit.mjs';

/** B站 API 根。 */
const BASE = 'https://api.bilibili.com';

/** 浏览器 UA（实测必须带，否则被拦）。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 单请求超时。 */
const TIMEOUT_MS = 20000;

/** WBI 密钥缓存（进程内，TTL 由 cfg 决定）。 */
let wbiCache = null;

/** 默认字幕语言优先级。 */
const LANG_PRIORITY = ['ai-zh', 'zh-CN', 'zh-Hans', 'ai-en', 'en-US'];

/** 业务错误（带 code，便于上层分支）。 */
export class BiliError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.name = 'BiliError';
    this.code = code || 'BILI_ERROR';
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

/**
 * 当前 SESSDATA（调用时读环境变量，不冻结）。
 *
 * ⚠️ 绝不外泄：只在 buildHeaders 里用。
 */
function sessdata() {
  return String(process.env.BILIBILI_SESSDATA || '').trim();
}

/** 构造 API 请求头（带 cookie）。 */
function apiHeaders() {
  const h = {
    accept: 'application/json',
    'user-agent': UA,
    referer: 'https://www.bilibili.com',
    origin: 'https://www.bilibili.com',
  };
  const sd = sessdata();
  if (sd) h.cookie = 'SESSDATA=' + sd;
  return h;
}

/** 构造 CDN 请求头（**不带 cookie**）。 */
function cdnHeaders() {
  return { 'user-agent': UA, referer: 'https://www.bilibili.com' };
}

/**
 * 把 B站 的 code 映射成我们的错误码。
 *
 * @param {number} code
 * @param {string} message
 * @returns {BiliError}
 */
function mapError(code, message) {
  const n = Number(code);
  const detail = message ? ': ' + message : '';
  if (n === -412) return new BiliError('B站 风控拦截' + detail, 'BILIBILI_RISK_CONTROL', { bilibiliCode: n });
  if (n === -403) return new BiliError('B站 拒绝访问' + detail, 'BILIBILI_FORBIDDEN', { bilibiliCode: n });
  if (n === -404) return new BiliError('视频不存在' + detail, 'BILIBILI_NOT_FOUND', { bilibiliCode: n });
  if (n === -101) return new BiliError('需要登录' + detail, 'BILIBILI_LOGIN_REQUIRED', { bilibiliCode: n });
  if (n === -400) return new BiliError('请求参数错误' + detail, 'BILIBILI_BAD_REQUEST', { bilibiliCode: n });
  return new BiliError('B站 接口错误 ' + String(n) + detail, 'BILIBILI_API_ERROR', { bilibiliCode: n });
}

/**
 * GET 一个 JSON 接口（API 域，带 cookie）。
 *
 * @param {string} path
 * @param {object} [params]
 * @returns {Promise<any>} 已解包的 data
 */
async function getJson(path, params) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url, {
      headers: apiHeaders(),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new BiliError('网络请求失败: ' + String(cause), 'BILIBILI_REQUEST_FAILED', { cause });
  }

  if (res.status >= 300 && res.status < 400) {
    throw new BiliError('拒绝重定向 HTTP ' + res.status, 'BILIBILI_REDIRECT_REFUSED');
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // 被风控时 B站 会返回 HTML 错误页
    throw new BiliError('响应不是 JSON（可能被风控拦截）', 'BILIBILI_BAD_RESPONSE', {
      status: res.status,
      sample: text.slice(0, 80),
    });
  }

  if (body && typeof body.code === 'number' && body.code !== 0) {
    throw mapError(body.code, body.message);
  }
  return body?.data;
}

/**
 * GET 一个 JSON（CDN 域，不带 cookie）。
 *
 * @param {string} rawUrl
 * @returns {Promise<any>}
 */
async function getCdnJson(rawUrl) {
  const url = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
  let res;
  try {
    res = await fetch(url, { headers: cdnHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new BiliError('字幕 CDN 请求失败: ' + String(cause), 'BILIBILI_REQUEST_FAILED', { cause });
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new BiliError('字幕 CDN 响应不是 JSON', 'BILIBILI_BAD_RESPONSE', { status: res.status });
  }
}

/**
 * 取 WBI 密钥（带进程内缓存）。
 *
 * @param {object} cfg
 * @param {number} nowMsValue
 * @returns {Promise<{imgKey:string,subKey:string}|null>}
 */
export async function getWbiKeys(cfg, nowMsValue) {
  const ttl = Number.isFinite(cfg?.wbiKeyTtlMs) ? cfg.wbiKeyTtlMs : 30 * 60 * 1000;
  const now = Number.isFinite(nowMsValue) ? nowMsValue : Date.now();

  if (wbiCache && now - wbiCache.at < ttl) return wbiCache.keys;

  const nav = await getJson('/x/web-interface/nav');
  const keys = extractWbiKeys(nav?.wbi_img);
  if (!keys) return null;

  wbiCache = { keys, at: now };
  return keys;
}

/** 测试用：清 WBI 缓存。 */
export function resetWbiCache() {
  wbiCache = null;
}

/**
 * 取视频元数据。
 *
 * @param {{bvid?:string,aid?:string|number}} param
 * @param {object} cfg
 * @returns {Promise<object>} 归一化后的 meta
 */
export async function fetchVideo(param, cfg) {
  const q = {};
  if (param?.bvid) q.bvid = param.bvid;
  else if (param?.aid) q.aid = param.aid;
  else throw new BiliError('缺少 bvid/aid', 'BILIBILI_BAD_REQUEST');

  const data = await withBackoff(() => getJson('/x/web-interface/view', q), cfg);
  if (!data) throw new BiliError('视频数据为空', 'BILIBILI_NOT_FOUND');

  return {
    bvid: String(data.bvid || ''),
    aid: Number(data.aid) || 0,
    cid: Number(data.cid) || 0,
    title: String(data.title || ''),
    desc: String(data.desc || ''),
    duration: Number(data.duration) || 0,
    author: String(data.owner?.name || ''),
    authorMid: Number(data.owner?.mid) || 0,
    cover: String(data.pic || ''),
    publishAt: Number(data.pubdate) || 0,
    // ⚠️ 实测 stat.view 经常是 undefined，这里做兜底
    play: Number(data.stat?.view) || 0,
    danmaku: Number(data.stat?.danmaku) || 0,
    pages: Array.isArray(data.pages)
      ? data.pages.map((p) => ({
          cid: Number(p.cid) || 0,
          page: Number(p.page) || 0,
          part: String(p.part || ''),
          duration: Number(p.duration) || 0,
        }))
      : [],
  };
}

/**
 * 取字幕轨列表（需要 WBI 签名）。
 *
 * @param {{bvid:string,cid:number}} param
 * @param {object} cfg
 * @returns {Promise<Array<{lan:string,url:string}>>}
 */
export async function fetchSubtitleTracks(param, cfg) {
  const keys = await getWbiKeys(cfg);
  if (!keys) return [];

  const signed = wbiSign(
    { bvid: param.bvid, cid: param.cid },
    keys.imgKey,
    keys.subKey,
    Math.floor(Date.now() / 1000),
  );

  const data = await withBackoff(() => getJson('/x/player/wbi/v2', signed), cfg);
  const list = Array.isArray(data?.subtitle?.subtitles) ? data.subtitle.subtitles : [];

  return list
    .map((t) => ({
      lan: String(t.lan || ''),
      url: String(t.subtitle_url || ''),
      ai: /^ai-/.test(String(t.lan || '')),
    }))
    .filter((t) => t.url);
}

/** 按优先级挑一条字幕轨。 */
export function pickTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  for (const want of LANG_PRIORITY) {
    const hit = tracks.find((t) => t.lan === want);
    if (hit) return hit;
  }
  const zh = tracks.find((t) => /zh/i.test(t.lan));
  return zh || tracks[0];
}

/**
 * 取字幕全文。
 *
 * @param {{bvid:string,cid:number}} param
 * @param {object} cfg
 * @returns {Promise<{text:string,lan:string,cueCount:number}|null>} 无字幕返回 null
 */
export async function fetchSubtitleText(param, cfg) {
  const tracks = await fetchSubtitleTracks(param, cfg);
  const track = pickTrack(tracks);
  if (!track) return null;

  const body = await getCdnJson(track.url);
  const cues = Array.isArray(body?.body) ? body.body : [];
  if (cues.length === 0) return null;

  const text = cues
    .map((c) => String(c?.content || '').trim())
    .filter(Boolean)
    .join('');

  return { text, lan: track.lan, cueCount: cues.length };
}

/**
 * 取视频预览雪碧图信息。
 *
 * ⚠️ 这是自研通道：插件的 bilibili_frames 找 preview_pic（接口已不返回），
 *    真正的位置是 /x/player/videoshot。
 *
 * @param {{bvid:string,cid:number}} param
 * @param {object} cfg
 * @returns {Promise<{images:string[],gridX:number,gridY:number,frameW:number,frameH:number}|null>}
 */
export async function fetchVideoshotInfo(param, cfg) {
  const data = await withBackoff(
    () => getJson('/x/player/videoshot', { bvid: param.bvid, cid: param.cid, index: 1 }),
    cfg,
  );

  const images = Array.isArray(data?.image) ? data.image.filter((u) => typeof u === 'string') : [];
  if (images.length === 0) return null;

  return {
    images,
    gridX: Number(data.img_x_len) || 10,
    gridY: Number(data.img_y_len) || 10,
    frameW: Number(data.img_x_size) || 480,
    frameH: Number(data.img_y_size) || 270,
  };
}

/**
 * 下载一张图片（CDN，不带 cookie）。
 *
 * @param {string} rawUrl
 * @returns {Promise<{data:Buffer,mediaType:string}>}
 */
export async function fetchImageBytes(rawUrl) {
  const url = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
  let res;
  try {
    res = await fetch(url, { headers: cdnHeaders(), signal: AbortSignal.timeout(40000) });
  } catch (cause) {
    throw new BiliError('图片下载失败: ' + String(cause), 'BILIBILI_REQUEST_FAILED', { cause });
  }
  if (!res.ok) throw new BiliError('图片 HTTP ' + res.status, 'BILIBILI_REQUEST_FAILED', { status: res.status });

  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const mediaType = type.includes('png') ? 'image/png'
    : type.includes('webp') ? 'image/webp'
    : type.includes('gif') ? 'image/gif'
    : 'image/jpeg';

  const arrayBuf = await res.arrayBuffer();
  return { data: Buffer.from(arrayBuf), mediaType };
}

export default {
  BiliError,
  getWbiKeys,
  resetWbiCache,
  fetchVideo,
  fetchSubtitleTracks,
  pickTrack,
  fetchSubtitleText,
  fetchVideoshotInfo,
  fetchImageBytes,
  LANG_PRIORITY,
};
