/**
 * roam/wbi — B站 WBI 请求签名（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 *   `/x/player/wbi/v2`（字幕轨列表）要求 WBI 签名，没签名的请求返回 -400。
 *   实测（2026-11-22）：自研复刻后能拿到 8 条字幕轨（ai-zh/en/ja/es/ar/pt/th/id）。
 *
 * 算法（B站公开算法，纯函数）
 *   1. 从 /x/web-interface/nav 拿 img_url / sub_url
 *   2. 各取文件名（去扩展名），拼成 64 字符密钥
 *   3. 经固定置换表 [46,47,18,...] 重排，取前 32 字符 = mixinKey
 *   4. 参数加 wts、按键名排序、值做 encodeURIComponent（去掉 !'()*）
 *   5. w_rid = md5(排序后的 query + mixinKey)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纪律
 *   · **纯函数**：无 IO、无 Date.now()（nowSec 入参）
 *   · 不 import 插件任何东西 —— 与插件完全解耦
 *   · 算法常量单列，便于对拍验证
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

/**
 * B站固定的 64 项置换表。
 *
 * ⚠️ 这是**协议常量**，不是魔法数字。B站改算法时这里也要跟着改，
 *    届时所有签名都会失败（错误码 -400），能快速定位。
 */
export const MIXIN_KEY_ENC_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]);

/** 签名前从参数值里去掉的保留字符。 */
const FILTER_CHARS = /[!'()*]/g;

/** 密钥材料最小长度（img key + sub key，各 32 字符）。 */
const MIN_KEY_LENGTH = 64;

/** mixinKey 输出长度。 */
const MIXIN_KEY_LENGTH = 32;

/**
 * 从 nav 接口的 wbi_img 结构里取两个密钥。
 *
 * @param {{img_url?:string, sub_url?:string}} wbiImg
 * @returns {{imgKey:string, subKey:string}|null} 取不到则 null（不抛）
 */
export function extractWbiKeys(wbiImg) {
  try {
    const imgUrl = String(wbiImg?.img_url ?? '').trim();
    const subUrl = String(wbiImg?.sub_url ?? '').trim();
    if (!imgUrl || !subUrl) return null;

    // 形如 https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
    const stem = (u) => {
      const parts = u.split('/');
      const last = parts[parts.length - 1] || '';
      const dot = last.lastIndexOf('.');
      return dot > 0 ? last.slice(0, dot) : last;
    };

    const imgKey = stem(imgUrl);
    const subKey = stem(subUrl);
    if (imgKey.length < MIXIN_KEY_LENGTH || subKey.length < MIXIN_KEY_LENGTH) return null;

    return { imgKey, subKey };
  } catch {
    return null;
  }
}

/**
 * 把 64 字符密钥材料经固定置换表折成 32 字符 mixinKey。
 *
 * @param {string} orig imgKey + subKey 拼接
 * @returns {string} 32 字符
 * @throws {Error} 材料不足 64 字符时（调用方应先用 extractWbiKeys 判空）
 */
export function mixinKey(orig) {
  const s = String(orig ?? '');
  if (s.length < MIN_KEY_LENGTH) {
    throw new Error('roam/wbi: key material must be at least ' + MIN_KEY_LENGTH + ' chars');
  }
  let out = '';
  for (const index of MIXIN_KEY_ENC_TAB) out += s[index];
  return out.slice(0, MIXIN_KEY_LENGTH);
}

/**
 * 给一组参数做 WBI 签名。
 *
 * @param {object} params 原始参数（值会被转成字符串）
 * @param {string} imgKey
 * @param {string} subKey
 * @param {number} nowSec unix 秒（入参，便于测试确定性）
 * @returns {Record<string,string>} 含 w_rid 与 wts 的签名后参数
 */
export function sign(params, imgKey, subKey, nowSec) {
  const wts = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const withWts = { ...(params || {}), wts };

  const query = Object.keys(withWts)
    .sort()
    .map((key) => key + '=' + encodeURIComponent(String(withWts[key]).replace(FILTER_CHARS, '')))
    .join('&');

  const wRid = createHash('md5').update(query + mixinKey(imgKey + subKey)).digest('hex');

  const signed = { w_rid: wRid };
  for (const [key, value] of Object.entries(withWts)) signed[key] = String(value);
  return signed;
}

/**
 * 一步到位：从 wbi_img 直接产出签名参数。
 *
 * @param {object} params
 * @param {{img_url?:string,sub_url?:string}} wbiImg
 * @param {number} nowSec
 * @returns {Record<string,string>|null} 密钥取不到则 null
 */
export function signWithKeys(params, wbiImg, nowSec) {
  const keys = extractWbiKeys(wbiImg);
  if (!keys) return null;
  try {
    return sign(params, keys.imgKey, keys.subKey, nowSec);
  } catch {
    return null;
  }
}

export default { MIXIN_KEY_ENC_TAB, extractWbiKeys, mixinKey, sign, signWithKeys };
