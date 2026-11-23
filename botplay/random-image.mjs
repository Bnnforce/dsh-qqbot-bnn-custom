// botplay 事件：来张图（图片直接内嵌进同一张卡片）
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatCardText } from '../lib/pure/card-format.mjs';
import { navButtons, handleNavClick } from '../lib/pure/card-nav.mjs';
import { DATA_ROOT, EXT_ROOT } from '../lib/pack-paths.mjs';

function keyOf(ctx) {
  const e = ctx?.event ?? {};
  return `${String(e.scope || '')}:${String(e.peerId || '')}`;
}
function saveLastImage(ctx, localPath, caption) {
  try {
    const file = join(DATA_ROOT, '.qqbot-extensions', 'data', 'last-bot-image.json');
    let all = {};
    try { all = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { all = {}; }
    all[keyOf(ctx)] = { at: Date.now(), path: String(localPath), caption: String(caption || '') };
    mkdirSync(join(DATA_ROOT, '.qqbot-extensions', 'data'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, file);
  } catch { /* ignore */ }
}
async function lib(ctx) {
  return import(pathToFileURL(join(EXT_ROOT, 'lib', 'io', 'random-image.mjs')).href + '?evt=' + Date.now());
}
function setCard(ctx, text) {
  const c = ctx.card();
  c.contentText = text;
  // ★ 2026-11-09：底部追加功能按钮（**不含自己**的「🖼 来张图」）
  //   主按钮从「🎲 再来一张」改成「🔁 换一张」：原来 🎲 与底部「🎲 骰子」功能按钮撞 emoji。
  c.buttons = [
    { id: 'again', label: '🔁 换一张', visitedLabel: '🔁 换一张', style: 1, botAction: { type: 'reply_text', text: '' } },
    ...navButtons('image'),
  ];
  return c;
}
async function uploadImage(ctx, localPath) {
  try {
    // 必须带版本参数：random-image 热重载时，静态 import 的 qq-media 仍会命中旧模块缓存。
    const { uploadLocalImage } = await import('./lib/qq-media.mjs?v=20261031-fast1');
    const up = await uploadLocalImage(ctx, localPath);
    const dim = up.width && up.height ? ` #${up.width}px #${up.height}px` : '';
    return `![图片${dim}](${up.url})`;
  } catch (e) {
    try {
      const { appendFileSync, mkdirSync } = await import('node:fs');
      const dir = join(DATA_ROOT, '.qqbot-extensions', 'data');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'random-image-diag.log'), `${new Date().toISOString()} ${JSON.stringify({ step: 'upload-fail', path: localPath, err: String(e?.message || e).slice(0, 240) })}\n`);
    } catch { /* ignore */ }
    return null;
  }
}

async function pickAndShow(ctx, mention = '', greeting = '发你一张。') {
  const { pickRandomImage } = await lib(ctx);
  const pick = pickRandomImage({ key: `event:${ctx.cardId}` });
  if (!pick.ok) {
    setCard(ctx, '## 🖼️ 来张图\n\n美图库空空的…先往「美图库」里丢几张吧。');
    return;
  }
  const up = await Promise.race([
    uploadImage(ctx, pick.path),
    new Promise((resolve) => setTimeout(() => resolve(''), 12000)),
  ]);
  if (up) {
    // ★ 全局：@ 单独一行 + 空行，再给 markdown 正文
    setCard(ctx, formatCardText({ mention, body: `${greeting}\n\n${up}` }));
    saveLastImage(ctx, pick.path, greeting);
  } else {
    setCard(ctx, formatCardText({ mention, body: `${greeting}\n\n图片上传失败，点「🔁 换一张」再试一次。` }));
  }
}
export default {
  name: '来张图',
  async onInit(ctx) {
    await pickAndShow(ctx, '', '发你一张。');
    ctx.card().dirty = false;
  },
  async onClick(ctx, info) {
    const btn = String(info.buttonId || '');
    // ★ 功能按钮（日历/骰子/抽签）：直接调用对应功能的现有实现，本卡不再变形
    const nav = await handleNavClick(ctx, btn);
    if (nav !== undefined) return nav;
    if (btn !== 'again') return;
    const id = String(ctx.user?.openid || '');
    await pickAndShow(ctx, id ? `${ctx.at(id)} ` : '', '换好啦，看看新图。');
    ctx.card().dirty = true;
    return '';
  },
};
