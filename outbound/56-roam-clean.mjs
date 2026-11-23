/**
 * outbound/56-roam-clean — 出站清洗（R5.7 打磨 2026-11-23）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这是个**真缺陷**，不是锦上添花）
 *
 *   `lib/roam/narrate.mjs` 里写了 `sanitizeOutput()`（剥 HTML / @ / markdown），
 *   但**全项目没有任何地方调用它** —— 只有导出，没有消费方。
 *
 *   而 R5.7 的回复路径是：
 *     命令 return { wake } → 宿主 injectSynthetic → AI 生成 → **直接发到群**
 *   AI 的回复**不经过我们任何代码** ⇒ 剥脏逻辑形同虚设。
 *
 *   实测踩过的脏东西（她都真的输出过）：
 *     · `<p>UP：xxx 时长 20 分钟</p>`
 *     · `<@（名字 openid 未知）>`
 *     · `[视频](https://www.bilibili.com/...)`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 怎么接（照 55-sulk-prefix 的验证过的写法）
 *   `export default async function onOutbound(ctx, next)`
 *   出站链按**文件名升序**执行，56 在 55 之后（sulk 加前缀 → 我们清脏）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条纪律
 *   ① **只动纯文字**（kind === 'text'）—— markdown/卡片/媒体一律 next()，
 *      清洗 markdown 会破坏 `##` 标题和 `![]()` 图片语法
 *   ② **没脏特征就不动手**（零成本正则预检）
 *   ③ **失败必放行** —— 清洗挂了绝不能让她的正常回复消失
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sanitizeOutput } from '../lib/roam/narrate.mjs';
import { diag } from '../lib/roam/store.mjs';

export const name = 'roam-clean';

/**
 * 脏特征预检：命中任一才做清洗。
 *
 * ⚠️ 这里刻意写得宽（误判只是多走一次清洗，不漏判才是关键）。
 */
const DIRTY = /<\/?[a-z][^>]{0,80}>|<@!?[^>]{0,60}>|\[[^\]]{1,80}\]\([^)]{0,200}\)|\*\*|__|(^|\n)#+\s/;

export default async function onOutbound(ctx, next) {
  try {
    // ① 只处理最后一个正文块（和 55 同款，避免分段处理）
    if (ctx?.isLastChunk === false) return next();

    // ② 只动纯文字
    const kind = String(ctx?.kind || '');
    if (kind !== 'text') return next();

    const raw = String(ctx?.text ?? '');
    if (!raw.trim()) return next();

    // ③ 没脏特征 → 零成本放行
    if (!DIRTY.test(raw)) return next();

    // ③.5) ★ 2026-11-23 修：先把 **不属于我们管** 的标记摘出来保护
    //
    //   出站链是共享的：`10-ensure-at-back`（文件名 10）刚给这条补的
    //   `<@openid>`、上游 `markers.js` 的 `[rf:xxx]`（引用回复标记）、
    //   `[MEDIA:...]`（媒体占位）—— 它们的语义归各自的环节，
    //   我们这层只有「剥模型自己瞎编的脏东西」的职责。
    //
    //   真实事故：`10-ensure-at-back` 补上 `<@>` 之后，本层把它剥掉，
    //   于是「被 @ 了就稳定 @ 回去」直接失效（roam-diag.log 有 2 条实证）。
    //
    //   ⚠️ 但保护面必须**只认合法形态**：QQ 的 @ 标记是 `<@32位十六进制>`。
    //      模型瞎编的 `<@（名字 openid 未知）>` 这种必须照样剥掉 —— 那正是本扩展存在的理由。
    //      所以这里不是"保护所有 <@...>"，而是"保护**像 openid 的**那一个"。
    const PROTECT = /(<@!?[0-9A-Fa-f]{6,64}>|\[rf:[^\]]{1,40}\]|\[MEDIA:[^\]]{1,120}\]|\[引用:[^\]]{1,40}\]|\[语音合成\])/g;
    const holders = [];
    const masked = raw.replace(PROTECT, (m) => {
      holders.push(m);
      return '\u0000' + (holders.length - 1) + '\u0000';
    });

    // ④ 清洗（上限放宽到 400，避免把正常长回复切短）
    //
    //   ★ 三个开关（2026-11-23 新增，默认全 false = 保留 R5.7 原来的激进行为）：
    //     · stripNamePrefix=false → 不剥行首「注意：/价格表：/https:」这类前缀
    //     · stripMentions=false   → 不剥 @（合法 @ 已 mask；不合法的手工剥，见 ④.2）
    //     · keepLines=true        → 保留换行（60-split-bubbles 靠换行拆气泡）
    let cleanedMasked = sanitizeOutput(masked, { promptMaxChars: 400 }, {
      stripNamePrefix: false,
      stripMentions: false,
      keepLines: true,
    });

    // ④.2) ★ 剥掉**不合法**的 @ 标记（模型编的 `<@（名字 openid 未知）>` 之类）
    //
    //   如果只把 `stripMentions` 关掉、什么都不做，上面那种脏东西就会原样发到群里 ——
    //   而这正是本扩展要解决的原始问题（version record 第 4 条 / 真机截图）。
    //   合法的已经在 ③.5 mask 掉了，这里剩下的 `<@...>` 一律是脏的，直接删。
    cleanedMasked = cleanedMasked.replace(/<@[^>]{0,120}>/g, '');

    // ④.5) 把保护标记放回去
    let cleaned = cleanedMasked.replace(/\u0000(\d+)\u0000/g, (_m, i) => holders[Number(i)] ?? '');

    // ⑤ 洗完没内容 → 拦下不发（避免空消息）
    if (!cleaned.trim()) {
      diag('[清洗] 全是脏东西，已拦下: ' + raw.slice(0, 50).replace(/\n/g, ' '));
      try { ctx.annihilate?.('roam-clean: 清洗后为空'); } catch { /* ignore */ }
      return;
    }

    // ⑥ 真的有变化才 rewrite
    if (cleaned !== raw) {
      diag('[清洗] ' + raw.slice(0, 50).replace(/\n/g, ' ') + ' → ' + cleaned.slice(0, 50));
      if (typeof ctx.rewrite === 'function') {
        ctx.rewrite(cleaned);
      }
    }
  } catch (e) {
    // 清洗失败一律放行（不能因为清洗 bug 让她的回复消失）
    try { diag('[清洗] 异常放行: ' + String(e?.message || e)); } catch { /* ignore */ }
  }
  return next();
}
