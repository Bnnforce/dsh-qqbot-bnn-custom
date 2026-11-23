import { DATA_ROOT, EXT_ROOT } from '../lib/pack-paths.mjs';
/**
 * botplay 事件：点歌（2026-11-19 R5.2 本地曲库版）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人要求的交互：
 *   /点歌 → 第一张卡片（功能名 + 介绍 + 两个按钮：🎲 随机 / 📋 列表）
 *   点「随机」→ 随机一首 → 发语音 + 更新卡片
 *   点「列表」→ 分页展示曲库
 *
 * ── 为什么必须做成 botplay 事件 ────────────────────────────────────────────
 *   QQ 卡片按钮的**回调只能**由 botplay 事件处理（扩展命令没法注册点击回调）。
 *   命令侧通过 triggerBotplay() 触发本事件，见 commands/点歌.mjs。
 *
 * ── 免费 ───────────────────────────────────────────────────────────────────
 *   主人要求去掉积分。本事件不读不写任何积分数据。
 * ═══════════════════════════════════════════════════════════════════════════
 */
const SONG_LIB = `${EXT_ROOT}/lib/song/index.mjs`;

/** 热重载友好：带时间戳 import。 */
async function lib() {
  return import(SONG_LIB + '?evt=' + Date.now());
}

/**
 * 设置卡片正文与按钮。
 * @param {object} ctx botplay 回调 ctx
 * @param {string} text
 * @param {Array} buttons
 */
function setCard(ctx, text, buttons) {
  const c = ctx.card();
  c.contentText = text;
  c.buttons = buttons;
  c.buttonsPerRow = 2;      // 两个按钮并排
  return c;
}

/** 标准两个按钮。 */
function twoButtons(randomLabel = '🎲 随机') {
  return [
    { id: 'random', label: randomLabel, style: 1, botAction: { type: 'reply_text', text: '' } },
    { id: 'list', label: '📋 列表', style: 0, botAction: { type: 'reply_text', text: '' } },
  ];
}

/**
 * 清理歌名里的括号注释（显示用）。
 *   例：`让我牵着你的手 (爱莉希雅原创曲)` → `让我牵着你的手`
 */
function cleanTitle(t, artist) {
  const s = String(t || '').trim();
  // 去掉末尾的（…）或 (…)，但如果去掉后为空就保留原样
  const stripped = s.replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
  return stripped || s;
}

/** 渲染第一屏（功能名 + 介绍 + 两个按钮）。 */
function renderHome(songs) {
  const st = safeStats(songs);
  return [
    '## 🎵 点歌',
    '',
    `想听什么？我这儿有 **${st.total}** 首。`,
    '',
    '🎲 随机一首，或者 📋 看看都有什么。',
    '',
    '⏱ 本卡片 5 分钟内有效。',
  ].join('\n');
}

/** 安全取统计（拿不到不炸）。 */
function safeStats(songs) {
  try {
    const arr = Array.isArray(songs) ? songs : [];
    return { total: arr.length, special: arr.filter((x) => x.special).length };
  } catch {
    return { total: 0, special: 0 };
  }
}

/** 渲染"随机到一首"的卡片正文。 */
function renderPicked(song, count) {
  const title = cleanTitle(song.title, song.artist);
  const lines = [`## 🎵 ${title}`, ''];
  if (song.artist) lines.push(`**${song.artist}**`, '');
  if (song.special) lines.push('*（这是爱莉希雅的歌。）*', '');
  else lines.push('（这首我常听。）', '');
  if (count > 0) lines.push(`第 ${count} 次点歌`);
  return lines.join('\n');
}

/** 渲染列表页。 */
function renderList(songs, page, perPage = 10) {
  const total = songs.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pages - 1));
  const slice = songs.slice(p * perPage, p * perPage + perPage);

  const lines = [`## 📋 曲库（${total} 首）`, ''];
  slice.forEach((s, i) => {
    const idx = p * perPage + i + 1;
    const t = cleanTitle(s.title, s.artist);
    const star = s.special ? ' ★' : '';
    const ar = s.artist ? ` - ${s.artist}` : '';
    lines.push(`${idx}. ${t}${ar}${star}`);
  });
  lines.push('');
  lines.push(`第 ${p + 1} / ${pages} 页`);
  return lines.join('\n');
}

/** 列表页的按钮：上一页/下一页 + 随机。 */
function listButtons(page, pages) {
  const out = [];
  if (page > 0) {
    out.push({ id: `page:${page - 1}`, label: '◀ 上一页', style: 0, botAction: { type: 'reply_text', text: '' } });
  }
  if (page < pages - 1) {
    out.push({ id: `page:${page + 1}`, label: '下一页 ▶', style: 0, botAction: { type: 'reply_text', text: '' } });
  }
  out.push({ id: 'random', label: '🎲 随机', style: 1, botAction: { type: 'reply_text', text: '' } });
  out.push({ id: 'home', label: '🏠 返回', style: 0, botAction: { type: 'reply_text', text: '' } });
  return out;
}

/** 每页条数。 */
const PER_PAGE = 10;

/** 单卡最多随机次数（防刷）。 */
const MAX_RANDOM = 5;

export default {
  name: '点歌',

  /**
   * 卡片首次展示。
   */
  async onInit(ctx) {
    let songs = [];
    try {
      const L = await lib();
      songs = L.getLibrary();
    } catch { /* 拿不到就显示 0 首 */ }

    setCard(ctx, renderHome(songs), twoButtons());
    ctx.card().dirty = false;
  },

  /**
   * 按钮点击。
   */
  async onClick(ctx, info) {
    const btn = String(info?.buttonId || '');
    let L;
    try { L = await lib(); } catch {
      await notify(ctx, '曲库模块加载失败。');
      return '';
    }
    const songs = (() => { try { return L.getLibrary(); } catch { return []; } })();

    // ── 随机 ──
    if (btn === 'random') {
      const n = ctx.clickCount ? ctx.clickCount('random') : 0;
      if (n >= MAX_RANDOM) {
        await notify(ctx, `这张卡已经点过 ${MAX_RANDOM} 首了，再发一次 /点歌 吧。`);
        return '';
      }

      const r = await L.pickAndConvert();
      if (!r.ok) {
        const why = r.reason === 'EMPTY_LIBRARY'
          ? '曲库是空的。'
          : r.reason?.startsWith('DECODE_FFMPEG')
            ? '解码器没装好。'
            : '这首放不出来。';
        await notify(ctx, why);
        // 卡片保持原样，仍可点列表
        return '';
      }

      // 发语音（关键：点一下就能听）
      let voiceOk = false;
      try {
        voiceOk = await ctx.media('voice', { localPath: r.silkPath });
      } catch { /* 发语音失败不影响卡片 */ }

      const count = (ctx.clickCount ? ctx.clickCount('random') : 0) + (voiceOk ? 1 : 0);
      const text = renderPicked(r.song, count) + (voiceOk ? '' : '\n\n*（语音没发出去，可能超了 60 秒限制。）*');
      setCard(ctx, text, twoButtons('🎲 再来一首'));
      ctx.card().dirty = true;
      return '';
    }

    // ── 列表 ──
    if (btn === 'list') {
      if (!songs.length) { await notify(ctx, '曲库是空的。'); return ''; }
      const pages = Math.max(1, Math.ceil(songs.length / PER_PAGE));
      setCard(ctx, renderList(songs, 0, PER_PAGE), listButtons(0, pages));
      ctx.card().dirty = true;
      return '';
    }

    // ── 翻页 ──
    const m = /^page:(\d+)$/.exec(btn);
    if (m) {
      if (!songs.length) { await notify(ctx, '曲库是空的。'); return ''; }
      const page = Number(m[1]) || 0;
      const pages = Math.max(1, Math.ceil(songs.length / PER_PAGE));
      setCard(ctx, renderList(songs, page, PER_PAGE), listButtons(page, pages));
      ctx.card().dirty = true;
      return '';
    }

    // ── 返回首页 ──
    if (btn === 'home') {
      setCard(ctx, renderHome(songs), twoButtons());
      ctx.card().dirty = true;
      return '';
    }

    return '';
  },
};

/** 给用户一条提示（不阻塞）。 */
async function notify(ctx, text) {
  try {
    if (typeof ctx.text === 'function') await ctx.text(String(text));
    else if (typeof ctx.markdown === 'function') await ctx.markdown(String(text));
  } catch { /* ignore */ }
}
