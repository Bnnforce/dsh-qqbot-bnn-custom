/**
 * roam/card — 发 B站 视频图文卡片（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件
 *   发卡片是「输出」能力，与「看懂视频」的取数能力正交。
 *   拆开之后：watch.mjs 只管拿数据，card.mjs 只管发出去。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 官方契约（extension-contract.md:253）
 *   `await env.card({ title, description, url, pic_url })`
 *     · title      ≤ 50 字（必需）
 *     · description ≤ 200 字
 *     · url        必须 https（必需）
 *     · pic_url    封面，https
 *   → 走官方 msg_type=8 图文卡片；发不出去**自动降级**成 markdown + 封面
 *
 * ⚠️ 官方卡片格式是 `card.type` + `card.content.{...}`，
 *    少包一层 content 会被拒（40011021）—— 这条来自 bili-share 的实测记录。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 最大的坑：QQ 主动消息窗口
 *   被动回复窗口只有几分钟。窗口过期时卡片必被拒 → 降级 markdown。
 *   所以「主动分享」（冷场时她开口）大概率只能拿到 markdown 降级形态。
 *   这不是 bug，是平台行为。我们不因此放弃，因为降级形态**也带封面图**。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { diag } from './store.mjs';

/** 官方硬限制。 */
export const LIMITS = Object.freeze({
  title: 50,
  description: 200,
  url: 1024,
  picUrl: 1024,
});

/** 默认描述（拿不到更好文案时用）。 */
const DEFAULT_DESC = 'B站上看到的，觉得还不错。';

/**
 * 把 http 图片地址升级成 https（官方要求 https）。
 *
 * @param {string} raw
 * @returns {string} 合法 https 地址；不合法返回空串
 */
export function normalizeHttpsUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('https://')) return s;
  if (s.startsWith('http://')) return 'https://' + s.slice('http://'.length);
  return '';
}

/**
 * 构造卡片载荷（纯函数，可单测）。
 *
 * @param {{bvid?:string,title?:string,author?:string,duration?:number,cover?:string,desc?:string}} meta
 * @param {{text?:string}} [narr] 她想说的话（作为 description 的前缀）
 * @returns {{ok:true,card:object}|{ok:false,reason:string}}
 */
export function buildCard(meta, narr) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const bvid = String(m.bvid || '').trim();
  if (!bvid) return { ok: false, reason: 'no-bvid' };

  const rawTitle = String(m.title || '').trim();
  const title = (rawTitle || ('B站视频 ' + bvid)).slice(0, LIMITS.title);

  const url = normalizeHttpsUrl('https://www.bilibili.com/video/' + bvid);
  if (!url) return { ok: false, reason: 'bad-url' };

  // description：优先用她的话，其次用视频简介，最后用兜底句
  const herWord = String(narr?.text || '').trim();
  const videoDesc = String(m.desc || '').replace(/\s+/g, ' ').trim();

  let desc;
  if (herWord) {
    // 她说的话在前，后面补 UP 主/时长，不塞简介（太长且像搬运）
    const extra = [];
    if (m.author) extra.push('UP：' + String(m.author).slice(0, 20));
    if (Number.isFinite(m.duration) && m.duration > 0) {
      const min = Math.floor(m.duration / 60);
      if (min > 0) extra.push(min + ' 分钟');
    }
    desc = extra.length > 0 ? herWord + ' · ' + extra.join(' · ') : herWord;
  } else if (videoDesc) {
    desc = videoDesc;
  } else {
    desc = DEFAULT_DESC;
  }
  desc = desc.slice(0, LIMITS.description);

  const picUrl = normalizeHttpsUrl(m.cover);

  return {
    ok: true,
    card: {
      title,
      description: desc,
      url: url.slice(0, LIMITS.url),
      // pic_url 可空（官方要求"封面必填"，但空了也让它降级而不是整体失败）
      pic_url: picUrl.slice(0, LIMITS.picUrl),
    },
  };
}

/**
 * 发卡片。失败自动降级 markdown（官方 env.card 内部已做，这里再加一层兜底）。
 *
 * @param {object} caps 扩展 caps（含 card / markdown）
 * @param {object} card buildCard 的产物
 * @returns {Promise<{ok:boolean, form:string, reason?:string}>}
 *   form: 'card' | 'markdown' | 'none'
 */
export async function sendCard(caps, card) {
  if (!card || !card.title || !card.url) {
    return { ok: false, form: 'none', reason: 'invalid-card' };
  }

  // ① 官方图文卡片（内部已含降级）
  if (typeof caps?.card === 'function') {
    try {
      const ok = await caps.card({
        title: card.title,
        description: card.description,
        url: card.url,
        pic_url: card.pic_url,
      });
      if (ok) return { ok: true, form: 'card' };
      diag('[卡片] 官方 card 返回 false（多为主动消息窗口过期）');
    } catch (e) {
      diag('[卡片] 官方 card 抛错: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ② 兜底：markdown + 封面
  if (typeof caps?.markdown === 'function') {
    try {
      const md = [
        '**' + card.title + '**',
        '',
        card.description,
        '',
        card.pic_url ? '![](' + card.pic_url + ')' : '',
        '',
        card.url,
      ].filter((x) => x !== '').join(String.fromCharCode(10));
      const ok = await caps.markdown(md);
      if (ok) {
        // ⚠️ 降级成功：form=markdown（不是卡片），调用方可据此决定要不要说明
        return { ok: true, form: 'markdown' };
      }
    } catch (e) {
      diag('[卡片] markdown 兜底也失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return { ok: false, form: 'none', reason: 'all-failed' };
}

/**
 * 一步到位：从 watch() 结果构造并发卡片。
 *
 * @param {object} caps
 * @param {object} result watch() 的返回
 * @param {string} [herWord] 她想说的话
 * @returns {Promise<{ok:boolean, form:string, reason?:string}>}
 */
export async function shareFromWatch(caps, result, herWord) {
  if (!result?.ok || !result?.meta) {
    return { ok: false, form: 'none', reason: 'no-meta' };
  }
  const built = buildCard(result.meta, { text: herWord });
  if (!built.ok) return { ok: false, form: 'none', reason: built.reason };
  return sendCard(caps, built.card);
}

export default { buildCard, sendCard, shareFromWatch, normalizeHttpsUrl, LIMITS };
