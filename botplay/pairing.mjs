// botplay 事件：随心配（卡片从扩展包迁到这里）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatCardText, clickerMention } from '../lib/pure/card-format.mjs';
import { navButtons, handleNavClick } from '../lib/pure/card-nav.mjs';
import { uploadLocalImage } from './lib/qq-media.mjs';
import { DATA_ROOT, EXT_ROOT } from '../lib/pack-paths.mjs';
import { loadPackage } from '../lib/pure/deps.mjs';

const sentPairImages = new Set();
async function lib(ctx) {
  return import(pathToFileURL(join(EXT_ROOT, 'lib', 'io', 'pairing.mjs')).href + '?evt=' + Date.now());
}
function setCard(ctx, text, buttons) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  return c;
}
const IDLE = '## 💞 随心配\n\n随机给你配一个本群群友。\n\n> 点「🎲 随心配」开始；配对 24 小时有效。';
// ★ 2026-11-09：底部追加功能按钮（4 项，**不含「随心配」自己**——它不在功能列表里）
//   注意按钮总数：随心配 2 个主按钮 + 4 个功能按钮 = 6 个，超过 perRow=1 时的 5 个上限
//   ⇒ 事件配置里 buttonsPerRow 必须改成 2（3 行 × 2 列 = 6），否则第 6 个被静默截断。
const IDLE_BUTTONS = [
  { id: 'pair', label: '🎲 随心配', style: 1, botAction: { type: 'reply_text', text: '' } },
  { id: 'cancel', label: '💔 取消配对', style: 0, botAction: { type: 'reply_text', text: '' } },
  ...navButtons('pairing'),
];
const PAIRED_BUTTONS = [
  { id: 'cancel', label: '💔 取消配对', style: 1, botAction: { type: 'reply_text', text: '' } },
  ...navButtons('pairing'),
];

/**
 * 懒加载 @napi-rs/canvas。
 *
 * ★ 2026-11-20 修 P1（审计）：原来写死 `~/.dsh/profiles/web/node_modules/@napi-rs/canvas`
 *   —— 假设了 DSH 的安装布局。silk-wasm 已经迁到 lib/pure/deps.mjs 的统一解析，
 *   canvas 这里漏了。现在同样走 deps.mjs（env → 包内 → 向上 → profile 兜底）。
 */
async function canvasLib() {
  const r = await loadPackage('@napi-rs/canvas', { envVar: 'BNN_CANVAS_ENTRY' });
  if (!r.ok) return null;
  return r.mod;
}
async function fetchAvatar(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'dsh-qqbot-pairing' } });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; } finally { clearTimeout(timer); }
}
export async function makePairImage({ dir, appid, a, b, aName, bName }) {
  const urlA = `https://thirdqq.qlogo.cn/qqapp/${encodeURIComponent(appid)}/${encodeURIComponent(a)}/100`;
  const urlB = `https://thirdqq.qlogo.cn/qqapp/${encodeURIComponent(appid)}/${encodeURIComponent(b)}/100`;
  const dataRoot = join(dir, '..', '..');
  const outDir = join(dataRoot, '.qqbot-extensions', 'data', 'pairing-avatars');
  const out = join(outDir, `${String(a).slice(0, 8)}-${String(b).slice(0, 8)}.png`);
  const [bufA, bufB] = await Promise.all([fetchAvatar(urlA), fetchAvatar(urlB)]);
  if (!bufA || !bufB) throw new Error('avatar download failed');
  const C = await canvasLib();
  if (!C?.createCanvas || !C?.loadImage) throw new Error('canvas unavailable');
  const [imgA, imgB] = await Promise.all([C.loadImage(bufA), C.loadImage(bufB)]);
  try {
    if (!C.GlobalFonts.__dshPairRegistered) {
      C.GlobalFonts.registerFromPath('/system/fonts/NotoSansCJK-Regular.ttc', 'CJK');
      C.GlobalFonts.__dshPairRegistered = true;
    }
  } catch { /* ignore font */ }
  const W = 460, H = 190;
  const canvas = C.createCanvas(W, H);
  const g = canvas.getContext('2d');
  g.fillStyle = '#242424';
  g.fillRect(0, 0, W, H);
  function drawRound(img, x, y, w, h, r) {
    g.save();
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
    g.clip();
    g.drawImage(img, x, y, w, h);
    g.restore();
  }
  const ax = 30, bx = 330, ay = 48, size = 100;
  drawRound(imgA, ax, ay, size, size, 10);
  drawRound(imgB, bx, ay, size, size, 10);
  const font = (px, weight = '') => `${weight ? weight + ' ' : ''}${px}px CJK, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const clean = (x, fb) => String(x || fb || '群友').replace(/^@/, '').slice(0, 16);
  const nameA = '@' + clean(aName, a);
  const nameB = '@' + clean(bName, b);
  g.font = font(18, 'bold');
  g.fillStyle = '#5aa2ff';
  g.fillText(nameA, ax + size / 2, 24);
  g.fillText(nameB, bx + size / 2, 24);
  const cy = ay + size / 2;
  g.strokeStyle = '#cfcfcf';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(ax + size + 8, cy);
  g.lineTo(bx - 8, cy);
  g.stroke();
  g.fillStyle = '#242424';
  g.fillRect(W / 2 - 30, cy - 15, 60, 30);
  g.font = font(20, 'bold');
  g.fillStyle = '#f2f2f2';
  g.fillText('结缘', W / 2, cy - 1);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, canvas.toBuffer('image/png'));
  return out;
}

async function pairCardImageMarkdown(ctx, p, appid) {
  try {
    const out = await makePairImage({
      dir: ctx.dir, appid,
      a: p.a, b: p.b,
      aName: p.aName, bName: p.bName,
    });
    const up = await uploadLocalImage(ctx, out);
    const dim = up.width && up.height ? ` #${up.width}px #${up.height}px` : '';
    return `![结缘${dim}](${up.url})`;
  } catch { return ''; }
}

async function sendPairImage(ctx, p, appid) {
  const key = `${ctx.cardId}:${p.id}`;
  if (sentPairImages.has(key)) return;
  try {
    const out = await makePairImage({
      dir: ctx.dir,
      appid,
      a: p.a, b: p.b,
      aName: p.aName, bName: p.bName,
    });
    const ok = await ctx.image({ localPath: out });
    if (ok) { sentPairImages.add(key); return; }
    throw new Error('image send failed');
  } catch {
    // 合成失败时退回两张原生头像消息，至少手机能看到头像。
    try {
      const L = await lib(ctx);
      await ctx.image({ url: L.avatarUrl(p.a, 100, appid) });
      await ctx.image({ url: L.avatarUrl(p.b, 100, appid) });
      sentPairImages.add(key);
    } catch { /* ignore */ }
  }
}

async function showCurrent(ctx) {
  const L = await lib(ctx);
  const gid = String(ctx.event.peerId || '');
  const openid = String(ctx.user.openid || '');
  if (!gid || !openid) return false;
  const st = L.loadState();
  L.prune(st);
  const p = L.findPair(st, gid, openid);
  if (!p) {
    setCard(ctx, IDLE + '\n\n现在还没有配对。', IDLE_BUTTONS);
    return true;
  }
  const appid = L.resolveAppId();
  const mine = p.a === openid ? { openid: p.a, name: p.aName || L.memberName(gid, p.a) } : { openid: p.b, name: p.bName || L.memberName(gid, p.b) };
  const other = p.a === openid ? { openid: p.b, name: p.bName || L.memberName(gid, p.b) } : { openid: p.a, name: p.aName || L.memberName(gid, p.a) };
  let text = L.buildPairCard({ a: mine, b: other, pairId: p.id, at: p.at, appid });
  // 先上传为 qqbot-media 再写进卡片：手机端只收一条带图带按钮的卡片。
  const imageMd = await Promise.race([
    pairCardImageMarkdown(ctx, p, appid),
    new Promise((resolve) => setTimeout(() => resolve(''), 4000)),
  ]);
  if (imageMd) {
    text = text.replace('\n\n> 左：', `\n\n${imageMd}\n\n> 左：`);
  }
  setCard(ctx, text, PAIRED_BUTTONS);
  if (!imageMd) {
    // 上传失败才退回单独图片消息；至少头像能看到。
    void sendPairImage(ctx, p, appid);
  }
  return true;
}

export default {
  name: '随心配',
  onInit(ctx) {
    setCard(ctx, IDLE, IDLE_BUTTONS);
  },
  async onClick(ctx, info) {
    const btn = String(info.buttonId || '');
    // ★ 功能按钮（日历/骰子/抽签/来张图）：直接调用对应功能的现有实现，本卡不变形
    const nav = await handleNavClick(ctx, btn);
    if (nav !== undefined) return nav;
    if (btn !== 'pair' && btn !== 'cancel') return;
    const L = await lib(ctx);
    const gid = String(ctx.event.peerId || '');
    const sender = String(ctx.user.openid || '');
    if (!gid || !sender) return '拿不到你的身份，稍后再试。';
    const senderName = String(ctx.user.pureName || ctx.user.name || '');
    if (btn === 'cancel') {
      const res = await L.withLock(async () => {
        const st = L.loadState();
        L.prune(st);
        const r = L.doCancel(st, gid, sender);
        if (r.ok) L.saveState(st);
        return r;
      });
      await showCurrent(ctx);
      const feedbackText = res.ok
        ? `已解除与 ${res.partnerName || '对方'} 的配对。`
        : '你当前没有配对喔。';
      // ★ 全局：@ 单独一行 + 空行，feedback 与卡片正文各成段（否则 md 失效）
      ctx.card().contentText = formatCardText({
        mention: clickerMention(ctx),
        body: feedbackText + '\n\n' + ctx.card().contentText,
      });
      ctx.card().dirty = true;
      return '';
    }
    if (btn === 'pair') {
      const res = await L.withLock(async () => {
        const st = L.loadState();
        L.prune(st);
        const r = L.doPair(st, gid, sender, senderName);
        if (r.ok) L.saveState(st);
        return r;
      });
      await showCurrent(ctx);
      const feedbackText = !res.ok ? (res.msg || '暂时无法配对，请稍后再试。') : '配对成功，看看卡片吧。';
      // ★ 全局：@ 单独一行 + 空行
      ctx.card().contentText = formatCardText({
        mention: clickerMention(ctx),
        body: feedbackText + '\n\n' + ctx.card().contentText,
      });
      ctx.card().dirty = true;
      return '';
    }
    return;
  },
};
