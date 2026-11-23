/**
 * roam/watch — 看一个视频：元数据 + 双通道 + 降级（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 双通道策略（实测修订，别改回串行）
 *   2026-11-22 实测：字幕与画面的覆盖率**互补**
 *     · 「编程教程」批 7 个 → 字幕 7/7，画面 0/7
 *     · 「崩坏」批 6 个    → 字幕 0/6，画面 6/6
 *   ⇒ 必须**并行**探测两个通道。串行的「字幕失败才抽帧」会白丢可用的画面。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 降级链（任意一环失败都不整体失败）
 *   元数据 失败 → 整体失败（没有标题就没法聊）
 *   字幕   失败 → 记 unavailable，继续
 *   画面   失败 → 记 unavailable，继续
 *   两个都失败 → 只用元数据（标题+简介）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { fetchVideo, fetchSubtitleText, BiliError } from './bili-api.mjs';
import { fetchFrames, describeFrames } from './videoshot.mjs';
import { isWorthWatching, planChannels, boundText } from './core.mjs';
import { readCache, writeCache, diag } from './store.mjs';

/**
 * 看一个视频。
 *
 * @param {{bvid?:string,aid?:string|number}} param
 * @param {object} cfg
 * @param {{mode?:'auto'|'subtitle'|'frames', skipCache?:boolean}} [opts]
 * @returns {Promise<object>}
 */
export async function watch(param, cfg, opts) {
  const mode = opts?.mode || 'auto';
  const bvidIn = String(param?.bvid || '').trim();

  /* ── 1. 元数据（必做，可走缓存）── */
  let meta = null;
  if (!opts?.skipCache && bvidIn) {
    meta = readCache(bvidIn, cfg?.metadataTtlMs);
    if (meta) diag('[看] ' + bvidIn + ' 元数据命中缓存');
  }

  if (!meta) {
    try {
      meta = await fetchVideo(param, cfg);
      if (meta?.bvid) writeCache(meta.bvid, meta);
    } catch (e) {
      const code = e?.code || 'BILIBILI_API_ERROR';
      diag('[看] ' + (bvidIn || '?') + ' 元数据失败: ' + code);
      return { ok: false, reason: mapFailReason(code), detail: String(e?.message || e) };
    }
  }

  if (!meta || !meta.bvid) {
    return { ok: false, reason: 'not-found', detail: '元数据为空' };
  }

  /* ── 2. 值不值得看 ── */
  const worth = isWorthWatching(meta, cfg);
  if (!worth.ok) {
    diag('[看] ' + meta.bvid + ' 跳过 reason=' + worth.reason + ' duration=' + meta.duration);
    return {
      ok: true,
      skip: true,
      reason: worth.reason,
      bvid: meta.bvid,
      meta: briefMeta(meta),
    };
  }

  /* ── 3. 规划通道 ── */
  const plan = planChannels(cfg, mode);
  const levels = { meta: 'ok', subs: 'skipped', frames: 'skipped' };
  let subtitle = null;
  let frames = null;

  /* ── 4+5. 双通道【并行】── */
  // ⚠️ 2026-11-23 性能优化：原来字幕和画面是**串行**的（各 4-5 秒，共 8-10 秒）。
  //   两者互不依赖（都只依赖 cid），可以并行 ⇒ 省一半时间。
  //   实测：串行 9.2 秒 → 并行约 5 秒。
  const subsTask = plan.subs
    ? (async () => {
        try {
          const sub = await fetchSubtitleText({ bvid: meta.bvid, cid: meta.cid }, cfg);
          if (sub && sub.text) {
            const bounded = boundText(sub.text, cfg?.subtitleMaxChars);
            levels.subs = 'ok';
            diag('[字幕] ' + meta.bvid + ' ' + sub.lan + ' ' + sub.cueCount + '条/' + sub.text.length + '字'
              + (bounded.truncated ? ' (截断到' + bounded.text.length + ')' : ''));
            return { text: bounded.text, truncated: bounded.truncated, lan: sub.lan, cueCount: sub.cueCount };
          }
          levels.subs = 'unavailable';
          diag('[字幕] ' + meta.bvid + ' 无字幕轨');
          return null;
        } catch (e) {
          levels.subs = 'unavailable';
          diag('[字幕] ' + meta.bvid + ' 失败: ' + (e?.code || e?.message || e));
          return null;
        }
      })()
    : Promise.resolve(null);

  const framesTask = plan.frames
    ? (async () => {
        try {
          const fr = await fetchFrames({ bvid: meta.bvid, cid: meta.cid }, cfg);
          if (fr.ok) {
            levels.frames = 'ok';
            return {
              sheets: fr.sheets,
              text: describeFrames({ gridX: fr.gridX, gridY: fr.gridY, sheets: fr.sheets.length }),
            };
          }
          levels.frames = 'unavailable';
          return null;
        } catch (e) {
          levels.frames = 'unavailable';
          diag('[画面] ' + meta.bvid + ' 失败: ' + (e?.code || e?.message || e));
          return null;
        }
      })()
    : Promise.resolve(null);

  // 等两条通道都完成（allSettled：一个失败不影响另一个）
  const [subsOut, framesOut] = await Promise.allSettled([subsTask, framesTask]);
  subtitle = subsOut.status === 'fulfilled' ? subsOut.value : null;
  frames = framesOut.status === 'fulfilled' ? framesOut.value : null;

  /* ── 6. 汇总 ── */
  const degraded = levels.subs !== 'ok' || levels.frames !== 'ok';
  diag('[看] ' + meta.bvid + ' 完成 meta=' + levels.meta
    + ' subs=' + levels.subs + ' frames=' + levels.frames);

  return {
    ok: true,
    skip: false,
    bvid: meta.bvid,
    meta: briefMeta(meta),
    subtitle,
    frames,
    levels,
    degraded,
  };
}

/** 只把需要的元数据带出去（省 token）。 */
function briefMeta(meta) {
  return {
    bvid: meta.bvid,
    title: meta.title,
    author: meta.author,
    duration: meta.duration,
    play: meta.play,
    desc: String(meta.desc || '').slice(0, 200),
    // ⚠️ cover 必须带出去 —— 发图文卡片要求 pic_url（没有封面，卡片会降级）
    cover: meta.cover || '',
  };
}

/** 把 API 错误码映射成对外 reason。 */
function mapFailReason(code) {
  switch (code) {
    case 'BILIBILI_NOT_FOUND': return 'not-found';
    case 'BILIBILI_RISK_CONTROL': return 'risk-control';
    case 'BILIBILI_FORBIDDEN': return 'forbidden';
    case 'BILIBILI_LOGIN_REQUIRED': return 'login-required';
    case 'BILIBILI_REQUEST_FAILED': return 'network';
    default: return 'error';
  }
}

export default { watch };
