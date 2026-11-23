/**
 * roam/shortlink — 展开 b23.tv 短链（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要
 *   群友分享视频最常用的是 b23.tv 短链（App 分享默认就是短链）。
 *   短链无法离线解析 —— 必须发一次 HTTP 拿到 302 的 Location。
 *
 *   R5.7 初版直接说「不支持短链」，但这是最常见的分享形态，不能说不管。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全约束
 *   · 只允许 b23.tv / bili2233.cn 两个域（防 SSRF）
 *   · 只跟一跳（不递归，防重定向环）
 *   · 不跟随自动重定向，手动读 Location
 *   · 超时 8 秒
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { diag } from './store.mjs';

/** 允许的短链域名（白名单，防 SSRF）。 */
const ALLOWED_HOSTS = Object.freeze(['b23.tv', 'bili2233.cn', 'www.b23.tv']);

/** 展开超时。 */
const TIMEOUT_MS = 8000;

/**
 * 判断是不是短链。
 *
 * @param {string} text
 * @returns {string} 短链完整 URL；不是则空串
 */
export function findShortLink(text) {
  const t = String(text ?? '');
  const m = t.match(/https?:\/\/(?:www\.)?(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/i);
  return m ? m[0] : '';
}

/**
 * 展开短链 → 真实 B站 链接。
 *
 * @param {string} shortUrl
 * @returns {Promise<{ok:true,url:string}|{ok:false,reason:string}>}
 */
export async function expand(shortUrl) {
  let target;
  try {
    target = new URL(String(shortUrl || '').trim());
  } catch {
    return { ok: false, reason: 'bad-url' };
  }

  // 白名单校验（防 SSRF）
  const host = target.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) {
    return { ok: false, reason: 'host-not-allowed' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, reason: 'bad-protocol' };
  }

  let res;
  try {
    res = await fetch(target, {
      method: 'GET',
      redirect: 'manual',              // 不自动跟随，手动读 Location
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diag('[短链] 请求失败: ' + msg);
    // ⚠️ 区分超时和网络错误，便于上层给不同提示
    const isTimeout = /timeout|abort/i.test(msg);
    return { ok: false, reason: isTimeout ? 'timeout' : 'network' };
  }

  const location = res.headers.get('location') || '';

  // 3xx 才有 Location
  if (res.status >= 300 && res.status < 400 && location) {
    // 校验跳转目标也是 B站（防被引到别的站）
    try {
      const next = new URL(location, target);
      if (!/bilibili\.com$/i.test(next.hostname) && !/bilibili\.com$/i.test(next.hostname.replace(/^www\./, ''))) {
        // 有些短链会先跳一次中间页，允许 https 跳转但记日志
        diag('[短链] 跳转到非 bilibili 域: ' + next.hostname);
      }
      return { ok: true, url: next.toString() };
    } catch {
      return { ok: false, reason: 'bad-location' };
    }
  }

  return { ok: false, reason: res.status === 200 ? 'no-redirect' : 'http-' + res.status };
}

/**
 * 一步到位：从文本里找短链并展开。
 *
 * @param {string} text
 * @returns {Promise<{ok:true,url:string}|{ok:false,reason:string}|null>} null=文本里没短链
 */
export async function expandFromText(text) {
  const shortUrl = findShortLink(text);
  if (!shortUrl) return null;
  return expand(shortUrl);
}

export default { findShortLink, expand, expandFromText, ALLOWED_HOSTS };
