/**
 * aac-image-to-path — 被 @ 时把「本条图 + 引用图」下载成本地路径交给模型
 *
 * 规则：群聊必须直接 @ 机器人；私聊视为直接对话。
 * 只处理本条消息附件 + 被引用消息附件；引用图同样只允许 read_image 读本次路径。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { access, constants, mkdir, writeFile } from 'node:fs/promises';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { join } from 'node:path';
import { calledByCurrentText } from '../lib/name.mjs';
import { nearbyMedia, consumeMedia } from '../lib/pure/recent-media.mjs';

export const name = 'image-to-path';

const MAX_IMAGES = 6;
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_KEY = Symbol.for('qqbot.current-image-paths');

function isImage(att) {
  const ct = String(att?.content_type ?? att?.contentType ?? '').toLowerCase().trim();
  if (ct === 'image' || ct.startsWith('image/')) return true;
  const name = String(att?.filename ?? '').toLowerCase();
  const url = String(att?.url ?? '');
  if (/\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)(?:[?#\s]|$)/i.test(`${name} ${url}`)) return true;
  if (att?.width && att?.height) return true;
  if (/[?&]appid=(1406|1407)(?:[&#]|$)/i.test(url)) return true;
  return false;
}

function quoteOf(ctx) {
  try {
    // ctx.quoted() 会补 fromSelf；优先用它，raw state.quote 只做兜底。
    if (typeof ctx?.quoted === 'function') {
      const q = ctx.quoted();
      if (q && (q.text || q.attachments || q.fromSelf !== undefined)) return q;
    }
    return ctx?.state?.quote;
  } catch { return ctx?.state?.quote; }
}
function attachmentsOf(ctx) {
  return Array.isArray(ctx?.message?.attachments) ? ctx.message.attachments : [];
}
export function looksLikeBotImageQuote(q) {
  const qt = String(q?.text ?? '').trim();
  // 只有引用正文本身确实像“图片卡”时才用 last-bot-image 兜底。
  // ⚠️ 不能只看 q.fromSelf：引用 bot 的任何一句文字回复也会 fromSelf=true，
  // 之前会把上一张女仆图塞进「知道什么」这种纯文字追问，导致模型答非所问。
  const imageCardText = /\[图片\]|发你一张|换好啦|这张图|!\[[^\]]*\]\(/u.test(qt);
  return imageCardText || (q?.fromSelf === true && qt === '');
}

function lastBotImage(ctx) {
  try {
    const q = quoteOf(ctx);
    if (!q) return '';
    if (!looksLikeBotImageQuote(q)) return '';
    const file = join(String(ctx.dataRoot || ''), '.qqbot-extensions', 'data', 'last-bot-image.json');
    const all = JSON.parse(readFileSync(file, 'utf8')) || {};
    const key = `${String(ctx.scope || '')}:${String(ctx.message?.groupOpenid ?? ctx.message?.senderId ?? '')}`;
    const hit = all[key];
    if (!hit || Date.now() - Number(hit.at || 0) > 15 * 60_000) return '';
    return existsSync(String(hit.path)) ? String(hit.path) : '';
  } catch { return ''; }
}
function quoteAttachmentsOf(ctx) {
  const q = quoteOf(ctx);
  return Array.isArray(q?.attachments) ? q.attachments : [];
}
function localImagePath(att) {
  const u = String(att?.url ?? '');
  return u.startsWith('/') && existsSync(u) ? u : '';
}
function remoteImageUrl(att) {
  const u = String(att?.url ?? '').trim();
  return /^https:\/\//i.test(u) ? u : '';
}
function imageMap() {
  let m = globalThis[IMAGE_KEY];
  if (!(m instanceof Map)) { m = new Map(); globalThis[IMAGE_KEY] = m; }
  return m;
}
const SENDER_KEY = Symbol.for('qqbot.current-sender');
function markGuardHasImage(ctx) {
  try {
    const m = globalThis[SENDER_KEY];
    if (!(m instanceof Map)) return;
    const e = m.get(targetKey(ctx));
    if (e && e.hasImage !== true) e.hasImage = true;
  } catch { /* ignore */ }
}

function targetKey(ctx) {
  const scope = String(ctx?.scope ?? '');
  const m = ctx?.message ?? {};
  const peer = scope === 'group' ? (m.groupOpenid ?? ctx?.replyTarget?.targetId ?? '') : (m.senderId ?? ctx?.replyTarget?.targetId ?? '');
  return `${scope}:${peer}`;
}
async function download(url, dir) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const resp = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'dsh-qqbot-image' } });
    if (!resp?.ok) return '';
    const ct = String(resp.headers?.get?.('content-type') ?? '').toLowerCase();
    if (ct && !ct.startsWith('image/')) return '';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return '';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg';
    const id = createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const path = join(dir, `${id}.${ext}`);
    await writeFile(path, buf);
    return path;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
async function pathsFor(atts, dir) {
  const out = [];
  let hadImage = false;
  for (const att of atts) {
    if (!isImage(att)) continue;
    hadImage = true;
    const local = localImagePath(att);
    if (local) { out.push(local); continue; }
    const url = remoteImageUrl(att);
    if (!url || !dir) continue;
    const p = await download(url, dir);
    if (p) out.push(p);
  }
  return { paths: out, hadImage };
}
async function readable(p) {
  try { await access(p, constants.R_OK); return true; } catch { return false; }
}
/** 2026-11-01 审查 P2-7：images/ 只增不减（一周 27MB）。下载入口做节流清理：
 *  超 7 天的删；仍超 300 个则按 mtime 删最旧；6h 最多跑一次。 */
let lastImageCleanup = 0;
function maybeCleanupImages(dir) {
  const now = Date.now();
  if (now - lastImageCleanup < 6 * 3600_000) return;
  lastImageCleanup = now;
  try {
    const files = readdirSync(dir).map((f) => {
      const p = join(dir, f);
      try { const st = statSync(p); return st.isFile() ? { p, mtime: st.mtimeMs } : null; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.mtime - b.mtime);
    const cutoff = now - 7 * 24 * 3600_000;
    let removed = 0;
    for (const f of files) {
      if (f.mtime >= cutoff && files.length - removed <= 300) continue;
      try { unlinkSync(f.p); removed += 1; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
function diag(root, row) {
  // 2026-11-01 审查 P2-6：诊断日志轮转（>256KB 归一到 .1）。
  try {
    appendLogRotating(join(root, '.qqbot-extensions', 'data', 'aac-diagnostics.jsonl'), JSON.stringify(row) + '\n', 256 * 1024);
  } catch { /* ignore */ }
}

function isSlashCommand(ctx) {
  let t = String(ctx?.text ?? '').trim();
  // 去掉 QQ @ 前缀 / 主人标记 / 引用前缀，再看是不是 /命令
  t = t.replace(/^(?:<@!?[^>]+>\s*)+/, '').replace(/^★主人\s*/, '').trimStart();
  return t.startsWith('/') || t.startsWith('／');
}

export async function onInbound(ctx, next) {
  try {
    const scope = String(ctx?.scope ?? '');
    if (scope !== 'group' && scope !== 'c2c') return next();
    // 群聊：被 @ 或叫名字（比安安/安安）都算对机器人说；c2c 是直接聊天
    if (scope === 'group' && !(ctx?.platform?.mentioned === true || calledByCurrentText(ctx))) return next();
    // 斜杠命令交给命令系统/botplay 桥，识图扩展不要给命令正文塞附近图路径
    if (isSlashCommand(ctx)) return next();

    const root = String(ctx.dataRoot || '');
    const dir = root ? join(root, '.qqbot-extensions', 'images') : '';
    if (dir) await mkdir(dir, { recursive: true });
    if (dir) maybeCleanupImages(dir);

    // 引用图优先看本地缓存路径；没有本地路径才下载
    const current = await pathsFor(attachmentsOf(ctx).slice(0, MAX_IMAGES), dir);
    const quoted = await pathsFor(quoteAttachmentsOf(ctx).slice(0, MAX_IMAGES), dir);
    const currentPaths = current.paths;
    const quotePaths = quoted.paths.slice();
    // bot 自己发的图卡被引用时，引用的附件通常是空的；用最近一次 bot 图片兜底。
    if (!quoted.hadImage) {
      const botImage = lastBotImage(ctx);
      if (botImage) quotePaths.push(botImage);
    }
    const paths = [...currentPaths, ...quotePaths].slice(0, MAX_IMAGES);

    // 本条/引用都没有图：回看同群、同发送者最近 120 秒、最多 10 条消息里的图。
    // 斜杠命令不走附近图，避免把旧图塞进命令上下文。
    let nearby = { attachments: [], ids: [] };
    let nearbyPaths = [];
    if (!paths.length && !String(ctx.text ?? '').trimStart().startsWith('/')) {
      nearby = nearbyMedia(ctx, { maxAgeMs: 120_000, maxMessages: 10, maxImages: 3 });
      const near = await pathsFor(nearby.attachments, dir);
      nearbyPaths = near.paths.slice(0, 3);
      paths.push(...nearbyPaths);
    }

    if (!paths.length) {
      if (current.hadImage || quoted.hadImage) {
        await diag(root, {
          timestamp: new Date().toISOString(), gid: String(ctx?.message?.groupOpenid ?? ''),
          senderId: String(ctx?.message?.senderId ?? ''), source: quotePaths.length ? '引用' : (nearbyPaths.length ? '附近' : '直接'),
          result: 'dead', reason: 'no_readable_path',
        });
        try { await ctx?.annihilate?.({ reason: '图片路径不可读，已丢弃本条', ownerAck: true }); } catch { /* ignore */ }
        return;
      }
      return next();
    }

    // 下载/本地路径统一做存活探测；任何一张不可读就不把死链交给模型
    const bad = [];
    for (const p of paths) if (!(await readable(p))) bad.push(p);
    if (bad.length) {
      await diag(root, {
        timestamp: new Date().toISOString(), gid: String(ctx?.message?.groupOpenid ?? ''),
        senderId: String(ctx?.message?.senderId ?? ''), source: quotePaths.length ? '引用/直接' : (nearbyPaths.length ? '附近' : '直接'),
        result: 'dead', reason: 'unreadable:' + bad.map((x) => String(x).slice(-80)).join('|'),
      });
      try { await ctx?.annihilate?.({ reason: '图片死链/不可读，已停止处理', ownerAck: true }); } catch { /* ignore */ }
      return;
    }

    // 2026-11-13（读图链路修复）：登记结构从「纯数组」升级为「数组 + 元信息」的混合形态：
    //   数组本体 = 本条图 + 引用图（**保持旧 guard 的 Array.isArray 读取路径可用**，
    //   万一只热重载了 inbound 没重载 hooks，旧 guard 仍能按旧语义工作）；
    //   额外属性：current / nearby / at —— 新 guard 用它们区分「本条/引用图」与「附近图」。
    // 为什么升级：工具 guard 原先按「当前发送者条目」的 mentioned/named 判「被@/叫名字」，
    //   但那条记录会被**回合中途到达的新消息覆盖**（实测 09:36：主人 @ 问「你读了图吗」，
    //   09:36:30 又进来一张贴纸把 entry 覆盖成"未@/未叫名"，09:36:31 的 read_image 就被误拒）。
    //   图片路径的登记**本身只在「被 @ / 叫名字」时才会发生**（见本函数开头的门控），
    //   所以 guard 改为认这份登记：本条/引用图直接放行，附近图附加 120 秒时效
    //   （对齐《00-安全规则》P1）。
    const reg = [...currentPaths, ...quotePaths];
    reg.current = reg.slice();
    reg.nearby = nearbyPaths.slice();
    reg.ts = Date.now(); // 时间字段用 ts：数组的 `at` 是 Array.prototype.at 方法，会串味
    imageMap().set(targetKey(ctx), reg);
    // 兼容仍在运行旧版 guard 的进程：本次注入的引用/附近图也算“有图”。
    markGuardHasImage(ctx);
    const lines = [];
    for (const p of currentPaths) lines.push(`[图片本地路径: ${p}]`);
    for (const p of quotePaths) lines.push(`[引用图片本地路径: ${p}]`);
    for (const p of nearbyPaths) lines.push(`[附近图片本地路径: ${p}]`);
    // 2026-11-04 改：原先是「先调用 read_image」的**无条件强制**，会导致
    // 「文字跟图无关也去读图」并且读不出时还叨叨「这张图读不出来」。
    // 现在改为**条件触发**：文字明确指向图才读；没提图就当图不存在。
    // 判据只交给模型按 00-安全规则 的 P1L 执行，这里只给指令、不下硬结论。
    lines.push(
      '【识图】只有当**上一条文字明确指向这张图**（如“这张/这图/你看这个/这是谁/图里写的什么/帮我看看”）'
      + '或图本身就是本条主内容时，才调用 read_image 读【本次图片路径】；只读本次图，不猜。'
      + '若文字没提图、只闲聊或只喊名字 → **当图不存在**：不读、不描述、不猜、也**不要说“读不出来/看不清”**，只按文字正常回。',
    );
    try {
      await ctx.rewrite?.({ text: `${String(ctx.text ?? '').trim()}\n${lines.join('\n')}`.trim(), reason: '识图：本条/引用/附近图转本地路径' });
      if (nearbyPaths.length) consumeMedia(ctx, nearby.ids);
    } catch { /* ignore */ }
  } catch { /* ignore */ }
  return next();
}
