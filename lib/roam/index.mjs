/**
 * roam/index — 上网逛逛的唯一对外接口（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么只暴露这一个文件
 *   tools/ hooks/ commands/ 三层入口都只 import 这里，不直接碰内部模块。
 *   这样内部重构（换实现、拆文件）不会波及入口代码。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 对外三个能力
 *   watchManual(gid, openid, bvid, cfg)   —— 手动看（/看 命令、工具调用）
 *   handleLink(gid, openid, text, cfg)    —— 被动响（群友发链接）
 *   proactiveRoam(gid, cfg)               —— 主动逛（定时）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { resolveConfig, nowMs } from './config.mjs';
import { parseBvid, toApiParam, shouldRoam, canRespond, dateKeyOf } from './core.mjs';
import { watch } from './watch.mjs';
import { readState, markSeen, hasSeen, hashOpenid, bumpProactive, bumpResponse, readCache, setLastWatched, diag } from './store.mjs';
import { isCircuitOpen, circuitRemainMs, recordFailure, recordSuccess } from './ratelimit.mjs';
// ⚠️ 2026-11-23 审计：buildLinkPrompt / fallbackLine 目前**无调用方**，
//   保留导出是为了开源 API 完整性（使用者可能要用），不算死代码。
import { buildWatchPrompt, buildLinkPrompt, sanitizeOutput, fallbackLine } from './narrate.mjs';
import { expandFromText } from './shortlink.mjs';
import { buildCard, sendCard, shareFromWatch } from './card.mjs';

/**
 * 主动逛的候选话题（她的兴趣域）。
 *
 * ⚠️ 2026-11-23 打磨：原来只有 5 个，每天 2 次 → 3 天就重复。
 *   扩到 18 个，并按「她的人设」分组：
 *     · 米哈游系（她的世界观）
 *     · 音乐/艺术（她的爱好）
 *     · 游戏（她玩的东西）
 *     · 生活/萌宠（轻松向）
 *     · 知识（偶尔正经一下）
 */
const ROAM_TOPICS = Object.freeze([
  // 米哈游 / 崩坏系
  '崩坏3 动画',
  '崩坏星穹铁道',
  '爱莉希雅',
  '米哈游 音乐',
  // 音乐 / 艺术
  '游戏音乐',
  '钢琴 演奏',
  '小提琴 演奏',
  '动漫 主题曲',
  '绘画教程',
  '板绘 过程',
  // 游戏
  '游戏攻略',
  '单机游戏 推荐',
  // 轻松向
  '猫猫 日常',
  '搞笑 合集',
  '美食 制作',
  // 知识向
  '科普 动画',
  '编程 入门',
  'AI 资讯',
]);

/**
 * 手动看一个视频。
 *
 * @param {{gid?:string, openid?:string, bvid?:string, mode?:string, cfg?:object}} input
 * @returns {Promise<object>}
 */
export async function watchManual(input) {
  const gid = String(input?.gid || '');
  const cfg = input?.cfg || resolveConfig();
  const now = nowMs();

  // 熔断检查
  if (isCircuitOpen(gid, now)) {
    const remain = Math.ceil(circuitRemainMs(gid, now) / 60000);
    diag('[拒绝] ' + gid + ' 熔断中，还剩 ' + remain + ' 分钟');
    return { ok: false, reason: 'circuit-open', remainMs: circuitRemainMs(gid, now) };
  }

  // 解析 bvid（短链要先展开）
  let parsed = parseBvid(input?.bvid);
  if (parsed?.type === 'short') {
    const ex = await expandFromText(input?.bvid);
    if (ex?.ok) {
      diag('[短链] 展开成功 ' + ex.url);
      parsed = parseBvid(ex.url);
    } else {
      diag('[短链] 展开失败 reason=' + (ex?.reason || 'unknown'));
      return { ok: false, reason: 'short-link', detail: '短链展开失败' };
    }
  }
  if (!parsed) {
    return { ok: false, reason: 'no-bvid', detail: '没找到 BV 号' };
  }

  const apiParam = toApiParam(parsed);
  const bvid = parsed.type === 'bvid' ? parsed.id : '';

  // 已看过：只有「被动响应」才去重；**显式要求（/看、工具调用）永远重新看**
  //   ⚠️ 2026-11-23 真机踩坑：用户今早再 /看 同一个视频，被 already-seen 拦下 +
  //   元数据缓存已过期（TTL 1h）→ 直接回「看不了这个视频」。这是**去重策略过激**。
  //   正解：去重只用于「群里自动响应链接」（防刷屏），用户明确要看就必须给。
  const isExplicit = input?.explicit !== false;   // 默认当作显式（/看 与工具调用都是显式）
  if (bvid && !isExplicit && hasSeen(gid, bvid)) {
    const cached = readCache(bvid, cfg.metadataTtlMs);
    if (cached && cached.bvid) {
      diag('[缓存] ' + gid + ' 已看过 ' + bvid + '，走缓存（可发卡）');
      const cachedResult = {
        ok: true,
        skip: false,
        fromCache: true,
        bvid: cached.bvid,
        meta: {
          bvid: cached.bvid,
          title: cached.title,
          author: cached.author,
          duration: cached.duration,
          play: cached.play,
          desc: String(cached.desc || '').slice(0, 200),
          cover: cached.cover || '',
        },
        subtitle: null,
        frames: null,
        levels: { meta: 'ok', subs: 'skipped', frames: 'skipped' },
        degraded: true,
      };
      return { ...cachedResult, prompt: buildWatchPrompt(cachedResult, cfg, { reason: 'link' }) };
    }
    diag('[跳过] ' + gid + ' 已看过 ' + bvid + '（无缓存，无法复用）');
    return { ok: false, reason: 'already-seen', bvid };
  }

  // 看
  const result = await watch(apiParam, cfg, { mode: input?.mode });

  if (result.ok) {
    recordSuccess(gid);
    if (bvid && !result.skip) {
      markSeen(gid, bvid, cfg);
      // ★ 记住「这个群最近看的是这支」，供「把这个发卡片」指代
      setLastWatched(gid, bvid);
    }
  } else {
    const { opened } = recordFailure(gid, now, cfg);
    if (opened) diag('[熔断] ' + gid + ' 连续失败达阈值');
  }

  return { ...result, prompt: buildWatchPrompt(result, cfg, { reason: 'link' }) };
}

/**
 * 被动响应：群里有人发了 B站 链接。
 *
 * @param {{gid?:string, openid?:string, text?:string, cfg?:object}} input
 * @returns {Promise<{handled:boolean, reason:string, result?:object, prompt?:string}>}
 */
export async function handleLink(input) {
  const gid = String(input?.gid || '');
  const openid = String(input?.openid || '');
  const text = String(input?.text || '');
  const cfg = input?.cfg || resolveConfig();
  const now = nowMs();

  if (!cfg.enabled) return { handled: false, reason: 'disabled' };

  let parsed = parseBvid(text);
  if (parsed?.type === 'short') {
    const ex = await expandFromText(text);
    if (!ex?.ok) {
      diag('[短链] 被动展开失败 reason=' + (ex?.reason || 'unknown'));
      return { handled: false, reason: 'short-link' };
    }
    parsed = parseBvid(ex.url);
  }
  if (!parsed) return { handled: false, reason: 'no-bvid' };

  const bvid = parsed.type === 'bvid' ? parsed.id : '';

  if (bvid && hasSeen(gid, bvid)) return { handled: false, reason: 'already-seen' };

  const state = readState(gid);
  const userKey = hashOpenid(openid);
  const gate = canRespond(state, userKey, cfg, now);
  if (!gate.yes) {
    diag('[限流] ' + gid + ' reason=' + gate.reason);
    return { handled: false, reason: gate.reason };
  }

  if (isCircuitOpen(gid, now)) return { handled: false, reason: 'circuit-open' };

  const result = await watch(toApiParam(parsed), cfg);

  if (!result.ok) {
    recordFailure(gid, now, cfg);
    return { handled: false, reason: result.reason };
  }
  recordSuccess(gid);

  if (result.skip) return { handled: false, reason: result.reason, result };

  if (bvid) markSeen(gid, bvid, cfg);
  bumpResponse(gid, userKey, now, dateKeyOf(now, cfg.timezone));

  return { handled: true, reason: 'ok', result, prompt: buildWatchPrompt(result, cfg, { reason: 'link' }) };
}

/**
 * 主动逛一次。
 *
 * ⚠️ 这里不搜视频——搜索要走插件的 bilibili_search，而 hook 拿不到 agent。
 *    所以由 hook 调 caps.wakeTo(prompt)，让她自己决定搜什么、看什么。
 *
 * @param {{gid?:string, cfg?:object, pick?:number}} input
 * @returns {Promise<{roamed:boolean, reason:string, prompt?:string, topic?:string}>}
 */
export async function proactiveRoam(input) {
  const gid = String(input?.gid || '');
  const cfg = input?.cfg || resolveConfig();
  const now = nowMs();

  const state = readState(gid);
  const gate = shouldRoam(state, cfg, now);
  if (!gate.yes) return { roamed: false, reason: gate.reason };

  if (isCircuitOpen(gid, now)) return { roamed: false, reason: 'circuit-open' };

  const seed = Number.isFinite(input?.pick) ? input.pick : Math.floor(now / 3600000);
  const topic = ROAM_TOPICS[Math.abs(Math.floor(seed)) % ROAM_TOPICS.length];

  const L = [];
  L.push('【系统提示 · 不是群友说的话】');
  L.push('');
  L.push('你现在有点空闲，想刷刷 B站 看看有什么。');
  L.push('');
  L.push('可以这样：');
  L.push('1. 用 bilibili_search 搜「' + topic + '」');
  // ⚠️ 2026-11-23 打磨：加时长提示 —— 实测她会挑到 42 秒的然后被过滤，白跑一次
  L.push('2. 挑一条你觉得有意思的（优先挑 1 分钟以上的，太短的没啥可说）');
  L.push('3. 用 bili_watch 看一下');
  // ★ 按 proactiveShareMode 决定说法（2026-11-23 主人定：默认 always）
  const mode = cfg.proactiveShareMode || 'always';
  if (mode === 'always') {
    L.push('4. 用 bili_watch 看的时候，必须加 share:true（发图文卡片，让群友知道是什么）');
    L.push('5. 发完卡片，再补一句你自己的感受（≤40字，不要重复标题）');
  } else if (mode === 'sometimes') {
    L.push('4. 觉得值得分享就加 share:true 发卡片；不想发就只说话');
    L.push('5. 无论发不发卡，都要说一句你自己的感受');
  } else {
    L.push('4. 用 bili_watch 看一下（不用发卡片）');
    L.push('5. 然后说一句你自己的感受（≤40字）');
  }
  L.push('');
  // ★ 2026-11-23 打磨：B站风控应对（实测连续搜索会被 ban，等 10-30 分钟恢复）
  L.push('【搜索被风控怎么办】');
  L.push('- 如果 bilibili_search 报 risk control / banned / 风控：');
  L.push('  ① 先换一个不同方向的关键词再试一次（把范围放宽，别用原词）');
  L.push('  ② 还是被 ban 就不要再试了，直接输出「。」（越试封得越久）');
  L.push('- 如果搜到了但 bili_watch 报太短/太长/看不了：');
  L.push('  → 从搜索结果里换一条再试（最多再试 2 条），都失败就输出「。」');
  L.push('');
  L.push('【硬约束】');
  L.push('- 只说你自己的感受，不复述内容、不列要点。');
  L.push('- 最多三句，不超过 ' + (cfg.promptMaxChars || 70) + ' 字。');
  L.push('- 没看到有意思的：只输出一个「。」就好（不要解释为什么不说）。');
  L.push('- 不许说「我查了一下」「我刚看到」。');
  L.push('- 不要输出 HTML 标签（<p> 等），不要 @ 人。');
  L.push('- 不要自己拼 markdown 链接，也不要自己假装发卡片。');
  L.push('');
  L.push('按你的人格说话。只输出消息正文。');

  bumpProactive(gid, now, dateKeyOf(now, cfg.timezone));
  diag('[主动逛] ' + gid + ' topic=' + topic);

  return { roamed: true, reason: 'ok', prompt: L.join(String.fromCharCode(10)), topic };
}

/**
 * 把她看过的视频分享成卡片。
 *
 * @param {{caps:object, gid?:string, bvid?:string, herWord?:string, cfg?:object}} input
 * @returns {Promise<{ok:boolean, form:string, reason?:string}>}
 */
export async function shareVideo(input) {
  const cfg = input?.cfg || resolveConfig();
  const caps = input?.caps;

  if (!caps) return { ok: false, form: 'none', reason: 'no-caps' };
  if (!cfg.enabled) return { ok: false, form: 'none', reason: 'disabled' };

  // 先看一遍（拿元数据）
  const looked = await watchManual({
    gid: String(input?.gid || ''),
    bvid: input?.bvid,
    cfg,
  });

  if (!looked.ok) return { ok: false, form: 'none', reason: looked.reason };
  if (looked.skip) return { ok: false, form: 'none', reason: looked.reason };

  return shareFromWatch(caps, looked, input?.herWord);
}

export {
  resolveConfig,
  nowMs,
  buildCard,
  sendCard,
  shareFromWatch,
  sanitizeOutput,
  fallbackLine,
  buildWatchPrompt,
  buildLinkPrompt,
  parseBvid,
  ROAM_TOPICS,
};

export default {
  watchManual,
  handleLink,
  proactiveRoam,
  shareVideo,
  buildCard,
  sendCard,
  resolveConfig,
  parseBvid,
  sanitizeOutput,
  fallbackLine,
};
