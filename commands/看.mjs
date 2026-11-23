/**
 * /看 —— 手动看一个 B站 视频（R5.7）
 *
 * 用法：
 *   /看 BV1fY4y1F7GL
 *   /看 https://www.bilibili.com/video/BV1fY4y1F7GL
 *   /看 https://b23.tv/xxxx
 *   /看 BV号 卡片          ← 发图文卡片（而不是文字）
 *
 * ⚠️ 设计原则（2026-11-22 真机返工）：
 *   命令是**群友能看到的回复**，不是调试面板。
 *   · 不吐字幕原文（字幕是给她理解用的，不是给群友看的）
 *   · 不输出 markdown 数据面板（**标题** / UP主：/ 字幕：/ 画面：）
 *   · 一句话说清楚：多长、什么内容、有没有字幕
 */
import { watchManual, resolveConfig } from '../lib/roam/index.mjs';
import { diag as diagCmd } from '../lib/roam/store.mjs';
import { buildCard, sendCard } from '../lib/roam/card.mjs';

/** 命令执行超时（看视频最慢约 5 秒）。 */
const TIMEOUT_MS = 20000;

/** 从命令 ctx 取群号。 */
function gidOf(ctx) {
  // ⚠️ 2026-11-23 真机踩坑：命令 ctx 里的真实路径是
  //   handlerArg.peer = { scope, peerId }   （官方 middleware-setup.js:609）
  //   handlerArg.caps.peer = { scope, peerId }
  //   handlerArg.message.groupOpenid
  //   我原来漏了 ctx.peer.peerId ⇒ gid='' ⇒ 状态写进 unknown.json ⇒ 去重跨群串味。
  const peer = ctx?.peer ?? ctx?.caps?.peer ?? {};
  const raw = peer.peerId
    || ctx?.caps?.peerId
    || ctx?.message?.groupOpenid
    || ctx?.message?.group?.openid
    || ctx?.message?.groupId
    || ctx?.groupOpenid
    || ctx?.group?.openid
    || '';
  return String(raw ?? '').trim();
}

/** 从命令 ctx 取 openid。 */
function openidOf(ctx) {
  return String(
    ctx?.user?.openid
    ?? ctx?.message?.sender?.openid
    ?? ctx?.caps?.user?.openid
    ?? '',
  ).trim();
}

const FAIL_TEXT = {
  'no-bvid': '没找到 BV 号。给我个 BV 号或者完整链接吧',
  'short-link': '这个短链打不开，给我完整链接吧',
  'circuit-open': 'B站 那边有点问题，先缓缓',
  'risk-control': 'B站 拦了，过会儿再看',
  'not-found': '这个视频好像没了',
  forbidden: '这个视频看不了',
  network: '网有点问题，等下再试',
};

const SKIP_TEXT = {
  'too-long': '这个太长了，看不完',
  'too-short': '这个太短了，没啥可说的',
  'low-quality': '看着像营销号，不想看',
};

/** 时长 → 人话。 */
function humanDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return h + ' 小时 ' + (m % 60 > 0 ? (m % 60) + ' 分钟' : '');
  }
  if (m > 0) return m + ' 分钟' + (r > 0 ? ' ' + r + ' 秒' : '');
  return r + ' 秒';
}

/** 播放量 → 人话。 */
function humanPlay(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 100000000) return (v / 100000000).toFixed(1) + ' 亿播放';
  if (v >= 10000) return (v / 10000).toFixed(0) + ' 万播放';
  return v + ' 播放';
}

export default {
  name: ['看', 'watch', 'bili'],
  description: '看一个 B站 视频（/看 BV号，加「卡片」二字发卡片）',
  usage: '/看 <BV号或链接> [卡片]',

  async handler(ctx) {
    const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();
    if (!raw) {
      return '要给我一个 BV 号呀，比如 /看 BV1fY4y1F7GL';
    }

    // ★ 先解析身份（后面的去重 / 指代 / 发卡都要用）
    const cfg = resolveConfig();
    const gid = gidOf(ctx);
    const openid = openidOf(ctx);

    // 是否要发卡片：尾部有「卡片」二字
    const wantCard = /卡片\s*$/.test(raw);
    let input = wantCard ? raw.replace(/\s*卡片\s*$/, '').trim() : raw;

    // ★ 支持指代：「同一个」「这个」「刚才那个」「last」→ 用该群最近看过的
    const REFER = /^(同一个|这个|那个|刚才那个|刚那个|上一条|上一个|last|same)$/i;
    if (REFER.test(input)) {
      const { getLastWatched } = await import('../lib/roam/store.mjs');
      const last = getLastWatched(gid);
      if (!last) {
        return '我还没看过什么呢，先给我一个 BV 号吧';
      }
      diagCmd('[指代] ' + JSON.stringify(input) + ' → ' + last);
      input = last;
    }

    let result;
    try {
      result = await Promise.race([
        watchManual({ gid, openid, bvid: input, cfg }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
      ]);
    } catch (e) {
      return e?.message === 'timeout' ? '看得有点慢，等下再说' : '看不了：' + String(e?.message || e);
    }

    if (!result.ok) {
      return FAIL_TEXT[result.reason] || '看不了这个视频';
    }

    if (result.skip) {
      return SKIP_TEXT[result.reason] || '这个不想看';
    }

    const meta = result.meta || {};

    /* ── 要卡片：直接发，不说多余话 ── */
    if (wantCard) {
      const built = buildCard(meta, { text: '' });
      if (!built.ok) return '做不出卡片：' + built.reason;
      const sent = await sendCard(ctx, built.card);
      if (!sent.ok) {
        return '卡片发不出去（可能太久没人说话了），我直接说吧：'
          + String(meta.title || '').slice(0, 30);
      }
      // ★ 2026-11-23 主人反馈：「第3条命令没问题，但是没有任何的说明」
      //   原来卡片发完只 return '发出去了' —— 群里只看到卡片，没有她的话。
      //   改成：卡片照发，另外唤醒她补一句（不重复标题，因为卡片上有）。
      const durTxt = humanDuration(meta.duration);
      const W = [];
      W.push('【系统提示 · 不是群友说的话】');
      W.push('');
      W.push('你刚给群里分享了一个 B站 视频（卡片已经发出去了）：');
      W.push('  标题：' + String(meta.title || '').slice(0, 50));
      if (meta.author) W.push('  UP主：' + String(meta.author).slice(0, 30));
      if (durTxt) W.push('  时长：' + durTxt);
      W.push('');
      if (result.subtitle?.text) {
        W.push('【视频大概讲了什么（仅供你理解，不要复述）】');
        W.push(String(result.subtitle.text).slice(0, 200));
        W.push('');
      }
      W.push('【本轮任务】');
      W.push('卡片已经发出去了，群友能看到标题和封面。');
      W.push('你只需要补一句：这视频讲了什么、你觉得怎么样。');
      W.push('');
      W.push('【硬约束】');
      W.push('- 不要重复标题（卡片上有），但要说清「讲了什么」。');
      W.push('- 最多三句，不超过 ' + (cfg.promptMaxChars || 70) + ' 字。');
      W.push('- 不要念字幕、不要用 HTML、不要 @ 人、不要用 markdown 记号。');
      W.push('- 按你的人格说话，别用客服腔。');
      W.push('');
      W.push('只输出消息正文。');
      return { wake: { content: W.join(String.fromCharCode(10)) } };
    }

    /* ── 不直接回模板，而是唤醒她自己说 ── */
    // ⚠️ 2026-11-23 主人反馈：「语气太人机了不像爱莉」。
    //   命令 handler 返回字符串 = 固定模板，不带人格、不看她当时的心情。
    //   正解：返回 { wake: { content } } —— 宿主会把它当成一条合成消息注入会话，
    //   让她带着人设/心情/上下文自己回（middleware-setup.js:662）。
    //   代价：她回什么由模型决定，不保证一定复述 BV 号（所以 prompt 里要求带上）。

    const dur = humanDuration(meta.duration);
    const play = humanPlay(meta.play);

    const L = [];
    L.push('【系统提示 · 不是群友说的话】');
    L.push('');
    L.push('你刚看了个 B站 视频：');
    L.push('  标题：' + String(meta.title || '').slice(0, 50));
    if (meta.author) L.push('  UP主：' + String(meta.author).slice(0, 30));
    if (dur) L.push('  时长：' + dur);
    if (play) L.push('  播放：' + play);
    L.push('  BV号：' + String(result.bvid || meta.bvid || ''));
    L.push('');

    if (result.subtitle?.text) {
      L.push('【视频里说了什么（节选，仅供你理解，不要复述）】');
      L.push(String(result.subtitle.text).slice(0, 200));
      L.push('');
    }

    L.push('【本轮任务】');
    L.push('主人让你看这个。用你自己的语气回他。');
    L.push('');
    L.push('说话要包含两层：');
    L.push('  ① 这是什么 —— 提一句标题或主题，让人知道是哪个视频');
    L.push('  ② 你的感受 or 看法 —— 这才是重点');
    L.push('');
    L.push('【硬约束】');
    L.push('- 可以提标题，但不要整段复述内容、不要念字幕。');
    L.push('- 最多三句，不超过 ' + (cfg.promptMaxChars || 70) + ' 字。');
    L.push('- 不许说「这个视频讲了」「内容是」「博主说」。');
    L.push('- 不要用 HTML，不要 @ 人，不要用 markdown 记号。');
    L.push('- 按你的人格说话，别用客服腔。');
    L.push('');
    L.push('只输出消息正文。');

    return { wake: { content: L.join(String.fromCharCode(10)) } };
  },
};
