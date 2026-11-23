/**
 * bili_watch — 看一个 B站 视频（R5.7 上网逛逛的核心入口）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 她怎么用它
 *   群里有人发链接 / 她自己刷到 → 调 bili_watch(bvid) → 拿到标题+字幕+画面
 *   → 然后用自己的话说一句（≤40 字，不复述内容）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 图片必须显式 deferContext（这是最容易踩的坑）
 *
 *   光把 attachmentId 放进返回值，**模型上下文里没有图**。
 *   必须调 exec.deferContext(createUserMessage({ content:[image...] }))。
 *
 *   证据链（三层都验过）：
 *     · dsh-tools/lib/pipeline.js:316  deferContext(c) { deferredContexts.push(c) }
 *     · dsh-tools/lib/pipeline.js:503  转成 additionalContexts
 *     · 插件 frames.js:279             实际用法
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三通道 + 降级
 *   元数据 必做（失败即整体失败）
 *   字幕 / 画面 并行探测（实测覆盖率互补，不能串行）
 *   两个都失败 → 只用元数据
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { watchManual, resolveConfig } from '../lib/roam/index.mjs';

/** 安全诊断（失败静默，不抛）。 */
function diagSafe(line) {
  try {
    import('../lib/roam/store.mjs').then((m) => m.diag(line)).catch(() => {});
  } catch { /* ignore */ }
}

/** 工具名。 */
export const name = 'bili_watch';

/** 单次最多返回几张图（防止 token 爆炸）。 */
const MAX_IMAGES = 2;

/**
 * 从 caps 里取 gid / openid。
 *
 * ⚠️ 两种上下文都要兼容（R5.6 踩过的坑）：
 *   · run()           → env.user.openid / env.peer
 *   · onInteraction() → ctx.performer.openid / ctx.peerId
 */
function idsOf(ctx, env) {
  // ⚠️ 2026-11-22 真机踩坑：官方 caps.peer 的结构是 { scope, peerId }，
  //   **没有 groupOpenid**！我原来先取 peer.groupOpenid 才对到 peer.peerId，
  //   但中间有一层 ctx.peer 拿不到导致 gid = ''（状态全写进 unknown.json）。
  //   ⇒ 现在按「官方真实字段优先」逐层兜底，并用 || 跳过空串。
  const caps = env?.caps ?? ctx ?? {};
  const peer = env?.peer ?? ctx?.peer ?? caps?.peer ?? {};

  const gid = String(
    peer.peerId            // ★ 官方：{ scope, peerId }
    || peer.groupOpenid
    || ctx?.peerId
    || env?.peerId
    || caps?.peerId
    || ctx?.groupId
    || env?.groupId
    || caps?.groupId
    || '',
  ).trim();

  // scope 兜底：c2c 私聊时不该把它当群
  const scope = String(peer.scope || ctx?.scope || caps?.scope || '').trim();
  if (scope === 'c2c' && !gid) return { gid: '', openid: '' };

  const openid = String(
    env?.user?.openid
    || ctx?.performer?.openid
    || ctx?.actorOpenid
    || env?.actorOpenid
    || caps?.user?.openid
    || '',
  ).trim();

  return { gid, openid, scope };
}

export default {
  name,
  expose: 'qq',
  description:
    '看一个 B站 视频：拿到标题/UP主/时长，读字幕（知道说了什么），抽画面帧（看到长什么样）。'
    + '看完用你自己的话说一句感受，不要复述内容、不要念字幕。'
    + '参数给 BV 号、视频链接或 b23.tv 短链。'
    + '想分享给群友看，加 share:true（会发图文卡片，然后你只需补一句感受）。',

  // ★ 2026-11-23 真机踩坑：没声明 timeoutMs 会用宿主默认（约 30s），
  //   而我们的最坏耗时 = 元数据退避30s + 字幕30s + 画面40s ≈ 100s
  //   ⇒ 必然 TOOL_TIMEOUT。这里显式给 120 秒。
  timeoutMs: 120000,

  inputSchema: {
    bvid: { type: 'string', description: 'BV 号或 B站 视频链接（必需；支持 b23.tv 短链）' },
    mode: { type: 'string', description: '可选：auto（默认）| subtitle（只读字幕）| frames（只看画面）' },
    share: { type: 'boolean', description: '可选：true=看完后发一张图文卡片到群里（默认 false）' },
  },

  async run(args = {}, env = {}, exec) {
    try {
      // ⚠️ 2026-11-23 真机踩坑：宿主调 run 时 this 不一定是这个对象字面量，
      //   所以 this.runInner 会 TypeError（实测 this.runInner is not a function）。
      //   正解：实现提到模块级函数 doRun，这里直接调（闭包，不依赖 this）。
      return await doRun(args, env, exec);
    } catch (e) {
      // ⚠️ 兜底：绝不让 ToolTimeoutError / 内部异常原样发到群里
      const code = String(e?.code || e?.name || '');
      const msg = String(e?.message || e);
      diagSafe('[工具] 异常 code=' + code + ' msg=' + msg.slice(0, 120));
      if (/TOOL_TIMEOUT|Timeout/i.test(code + msg)) {
        return { ok: false, reason: 'timeout', message: '看得有点慢，等下再说' };
      }
      return { ok: false, reason: 'error', message: '看不了这个视频' };
    }
  },

};

/**
 * 工具的实际实现（模块级函数，**不依赖 this**）。
 * ⚠️ 2026-11-23 真机踩坑：宿主调 run 时 this 不一定指向对象字面量，
 *   this.runInner 会 TypeError（实测 this.runInner is not a function）。
 *   ⇒ 实现体放模块级，run 直接闭包调用。
 */
async function doRun(args = {}, env = {}, exec) {
    const ctx = env?.caps || env;
    const cfg = resolveConfig();
    const { gid, openid } = idsOf(ctx, env);

    // ★ 支持「这个」「刚才那个」：bvid 为空或 'last' 时用该群最近看过的
    let raw = String(args?.bvid || '').trim();
    if (!raw || raw === 'last' || raw === '这个' || raw === '最近') {
      const { getLastWatched } = await import('../lib/roam/store.mjs');
      const last = getLastWatched(gid);
      if (!last) {
        return { ok: false, reason: 'no-bvid', message: '要给我一个 BV 号呀，或者先用 /看 看一个。' };
      }
      raw = last;
    }

    // 走编排层
    const result = await watchManual({
      gid,
      openid,
      bvid: raw,
      mode: args?.mode,
      cfg,
    });

    /* ── 失败分支：给模型人话 ── */
    if (!result.ok) {
      const msg = {
        'no-bvid': '没在这段话里找到 BV 号。',
        'short-link': 'b23.tv 短链打不开，能不能给我完整链接？',
        'already-seen': '这个刚才看过了。',
        'circuit-open': 'B站 那边有点问题，先缓缓。',
        'risk-control': 'B站 拦了，过会儿再看。',
        'not-found': '这个视频好像没了。',
        'forbidden': '这个视频看不了。',
        network: '网有点问题。',
      }[result.reason] || '看不了这个视频。';
      return { ok: false, reason: result.reason, message: msg };
    }

    /* ── 不值得看 ── */
    if (result.skip) {
      const why = {
        'too-long': '这个太长了，看不完。',
        'too-short': '这个太短了，没啥可说的。',
        'low-quality': '看着像营销号，不想看。',
      }[result.reason] || '这个不想看。';
      return {
        ok: true,
        skip: true,
        reason: result.reason,
        title: result.meta?.title || '',
        message: why,
}

    }

    /* ── 成功：把图片注入上下文（关键！）── */
    let imageCount = 0;
    if (result.frames?.sheets?.length > 0) {
      const sheets = result.frames.sheets.slice(0, MAX_IMAGES);
      imageCount = sheets.length;

      // ⚠️ 必须 deferContext，否则模型看不见图
      if (exec && typeof exec.deferContext === 'function') {
        try {
          const attachments = ctx?.get?.('attachments') ?? env?.ctx?.get?.('attachments');
          if (attachments && typeof attachments.saveImage === 'function') {
            const refs = [];
            for (const s of sheets) {
              const ref = await attachments.saveImage({
                data: s.data,
                mediaType: s.mediaType || 'image/jpeg',
                name: result.bvid + '-frame.jpg',
              });
              refs.push(ref);
            }
            if (refs.length > 0) {
              const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
              exec.deferContext(createUserMessage({
                content: [
                  { type: 'text', text: result.frames.text || '' },
                  ...refs.map((r) => ({
                    type: 'image',
                    attachment: {
                      attachmentId: r.attachmentId,
                      mediaType: r.mediaType,
                      bytes: r.bytes,
                      width: r.width,
                      height: r.height,
                    },
                  })),
                ],
                source: { kind: 'plugin', plugin: 'bnn-roam' },
              }));
            }
          }
        } catch {
          // 图片注入失败不影响文字部分
          imageCount = 0;
        }
      }
    }

    /* ── 可选：发卡片 ── */
    let shared = null;
    if (args?.share === true) {
      try {
        const { buildCard, sendCard } = await import('../lib/roam/card.mjs');
        const built = buildCard(result.meta, { text: '' });
        if (built.ok) {
          shared = await sendCard(ctx, built.card);
        } else {
          shared = { ok: false, form: 'none', reason: built.reason };
        }
      } catch (e) {
        shared = { ok: false, form: 'none', reason: String(e?.message || e) };
      }
    }

    /* ── 组装返回 ── */
    const out = {
      ok: true,
      bvid: result.bvid,
      title: result.meta?.title || '',
      author: result.meta?.author || '',
      duration: result.meta?.duration || 0,
      desc: result.meta?.desc || '',
      subtitle: result.subtitle
        ? {
            text: result.subtitle.text,
            lan: result.subtitle.lan,
            cueCount: result.subtitle.cueCount,
            truncated: result.subtitle.truncated,
          }
        : null,
      images: imageCount,
      levels: result.levels,
      ...(result.fromCache ? { fromCache: true } : {}),
      hint: buildHint(result, shared),
      ...(shared ? { shared } : {}),
    };

    return out;
}

/**
 * 给她一句"该怎么用这些材料"的提示。
 *
 * @param {object} result
 * @returns {string}
 */
function buildHint(result, shared) {
  const hasSub = result.levels?.subs === 'ok';
  const hasImg = result.levels?.frames === 'ok';

  // ⚠️ 方案 A：卡片已发时，只补一句话，**不要重复报标题**
  //   （2026-11-22 真机：她发完卡又念一遍标题+UP+播放量，很啰嗦）
  if (shared?.ok) {
    return '卡片已经发出去了。现在只需要补一句你自己的感受（不超过 40 字）。'
      + '不要重复标题，不要报 UP 主和播放量（卡片上都显示了），'
      + '不要用 HTML，不要 @ 人，不要用 markdown 记号。';
  }

  if (hasSub && hasImg) {
    return '字幕和画面都拿到了。看完说你自己的感受，最多两句，别复述内容。';
  }
  if (hasSub) {
    return '只有字幕，没有画面。看完说你自己的感受，别念字幕。';
  }
  if (hasImg) {
    return '只有画面，没有字幕。看画面然后说你自己的感受。';
  }
  return '只拿到标题和简介。如果没什么想说的，就别说。';
}
