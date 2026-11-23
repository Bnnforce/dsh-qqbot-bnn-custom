/** 上传本地图片到 QQ 素材库，返回 qqbot-media:// 引用与宽高。 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const tokenCache = new Map();
const localCache = new Map();
async function getToken(ctx) {
  const appId = String(ctx?.appId || '');
  const appSecret = String(ctx?.appSecret || '');
  if (!appId || !appSecret) throw new Error('missing app credentials');
  const hit = tokenCache.get(appId);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  });
  const j = await r.json();
  if (!j?.access_token) throw new Error('get token failed');
  tokenCache.set(appId, { token: j.access_token, expiresAt: Date.now() + Number(j.expires_in || 7200) * 1000 });
  return j.access_token;
}
async function api(token, method, path, body) {
  const r = await fetch('https://api.bot.qq.com' + path, {
    method,
    headers: { authorization: 'QQBot ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.code) throw new Error(`${path} HTTP ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}
async function listImages(token, maxPages = 1) {
  const out = [];
  let cursor = '';
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const q = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
      const j = await api(token, 'GET', '/v2/media-images' + q);
      if (Array.isArray(j?.images)) out.push(...j.images);
      const next = String(j?.next_cursor || '');
      if (!next || !j?.images?.length) break;
      cursor = next;
    }
  } catch { /* return what we have */ }
  return out;
}

/** 配额接近 100 时，删掉最旧的素材，保留最近 80 张。 */
async function pruneMediaIfNeeded(token) {
  const images = await listImages(token, 20);
  if (images.length < 95) return images;
  const sorted = images.slice().sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
  // 先删我们自己生成的 dsh_*，不够再删最旧的其他素材。
  const ours = sorted.filter((x) => String(x.file_name || '').startsWith('dsh_'));
  const targets = [...ours, ...sorted.filter((x) => !String(x.file_name || '').startsWith('dsh_'))]
    .slice(0, Math.max(0, images.length - 80));
  for (const img of targets) {
    const id = String(img?.image_id || '');
    if (!id) continue;
    try { await api(token, 'DELETE', '/v2/media-images/' + encodeURIComponent(id) + '/delete'); } catch { /* 删不掉就继续 */ }
  }
  return listImages(token);
}

/**
 * 读图片尺寸（PNG/GIF/JPEG/WebP 文件头，~45 行纯解析）。
 *
 * ★ 2026-11-15 重写：原来这里 `import()` 插件 dist 的 features/md-media.js。
 *   两条理由要去掉这个依赖：
 *     ① 官方扩展契约明确写「**不要 import 插件 dist/**」——内部模块重构不保证形状，
 *        一改就静默坏掉（import 抛错被 try 吞了 ⇒ 尺寸永远 0，你还不知道）；
 *     ② 这个函数是**自包含的纯字节解析**，没有调用插件任何状态，抄过来零成本。
 *   算法与上游 md-media.js 的 imageSize() 逐字节一致（含 SOF 段扫描与 VP8X/VP8L 分支），
 *   遇到 WebP 的 VP8（无扩展头）等不支持形态仍然返回 0，与上游行为相同。
 */
function imageSize(buf) {
  if (!buf || !buf.length) return { width: 0, height: 0 };
  // PNG: 8 字节签名 + IHDR
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: 扫 SOFn 段
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1] ?? 0;
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15（排除 DHT/JPG/DAC）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  // WEBP（VP8X：宽高在 offset 24 起，各 3 字节 LE，存的是值-1；VP8L 位打包）
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (kind === 'VP8L' && buf.length > 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return { width: 0, height: 0 };
}
function extOf(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p));
  return (m?.[1] || '').toLowerCase();
}
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export async function uploadLocalImage(ctx, localPath) {
  if (!localPath || !existsSync(localPath)) throw new Error('image not found');
  const ext = extOf(localPath);
  const contentType = TYPES[ext];
  if (!contentType) throw new Error('unsupported image: ' + ext);
  const buf = readFileSync(localPath);
  if (!buf.length || buf.length > 10 * 1024 * 1024) throw new Error('image size invalid');
  const md5 = createHash('md5').update(buf).digest('hex');
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const token = await getToken(ctx);
  const fileName = `dsh_${md5.slice(0, 16)}.${ext}`;
  // 同一张图在本进程内已经传过，直接复用，避免再拉列表。
  const cacheKey = String(localPath);
  const cached = localCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.value;
  // 只拉第一页做复用检查；正常配额下不再为每张图翻完 100 张列表。
  const images = await listImages(token, 1);
  const existing = images.find((x) => String(x?.file_name || '') === fileName && String(x?.url || '').trim());
  if (existing) {
    const size = imageSize(buf);
    const value = { url: String(existing.url), width: size.width, height: size.height, imageId: String(existing.image_id || '') };
    localCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
  let prep;
  try {
    prep = await api(token, 'POST', '/v2/media-images/prepare', {
      file_name: fileName, file_size: buf.length, content_type: contentType, md5, sha1,
    });
  } catch (e) {
    // 并发上传或其他插件刚占满配额：清一轮旧素材再重试一次。
    if (!/quota|40035007|too many/i.test(String(e?.message || e))) throw e;
    await pruneMediaIfNeeded(token);
    prep = await api(token, 'POST', '/v2/media-images/prepare', {
      file_name: fileName, file_size: buf.length, content_type: contentType, md5, sha1,
    });
  }
  if (!prep?.upload_id || !prep?.presigned_url) throw new Error('prepare missing fields');
  const put = await fetch(prep.presigned_url, {
    method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(buf),
  });
  if (!put.ok) throw new Error('upload HTTP ' + put.status);
  const etag = (put.headers.get('etag') || md5).replace(/^"+|"+$/g, '');
  const done = await api(token, 'POST', '/v2/media-images/complete', { upload_id: prep.upload_id, md5: etag });
  if (!done?.url) throw new Error('complete missing url');
  const size = imageSize(buf);
  const value = { url: String(done.url), width: size.width, height: size.height, imageId: String(done.image_id || '') };
  localCache.set(cacheKey, { at: Date.now(), value });
  return value;
}
