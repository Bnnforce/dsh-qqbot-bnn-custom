/**
 * trigger-force-wake — 群聊应答门控（P0）+ 图片判定（P1/P2）
 *
 * 主人 2026-10-19 定的硬性准则：
 *   P0 群里只有「被 @ / 叫名字比安安」的消息才允许唤醒 AI 回复；
 *      其余消息一律不回复（连主人发的无关闲聊也不回）。
 *   识图：群聊只有被 @ + 本条带图、或私聊附图时才允许 read_image；
 *      没 @ 的群图不读、不描述、不解读，只按文字回。
 *   P2 群图默认不主动解读（未满足 P0 连看都不看；同一张图只看一次）。
 *   优先级：P0 > P1 > P2。
 *
 * 实现方案（零熔断风险）：
 *   · 宿主 requireMention=true —— 群聊非 @ 消息由 SDK mentionGate **原生拦截**，
 *     不进 AI、不耗 token；但消息在门控之前已进「群历史缓冲」（historyLimit 条），
 *     所以下次她被点名时仍能读到之前的闲聊（= 读全部，但不主动回）。
 *   · 本扩展在门控**之前**跑，只对两类消息 forceWake 放行：
 *       ① 被 @ / 叫名字；② 斜杠命令（剥 @ 前缀后直通命令层）。
 *   · 其余消息什么都不做，让门控原样拦掉。
 *
 * ⚠️ 为什么不用 silentInto + annihilate 做“静默进上下文”：
 *   入站扩展有「破坏性动作熔断」（最近 50 条里 >50% 是消灭/静默就停用），
 *   凡是每条群消息都 annihilate 的方案，几十条闲聊后门控就会失效。
 */
export const name = 'trigger-force-wake';

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calledByCurrentText } from '../lib/name.mjs';
import { dirname, join } from 'node:path';

/** 出站扩展 dedupe-replies 维护的「最近回复」台账 */
import { EXT_DATA } from '../lib/pack-paths.mjs';

/**
 * at-sender.json 的**内存缓存 + 延迟刷盘**（2026-11-15，入站提速）。
 *
 * 为什么改：原来**每一条未 @ 的群消息**都要
 *   readFileSync(整个 json) → 遍历清理 → writeFileSync(.tmp) → renameSync
 * 四次磁盘操作全压在入站链路上（实测文件 3.4KB / 10+ 条目，但群里每句都走一遍）。
 * 而这份数据只被**出站**在"回复时"读一次，完全不需要消息一到就落盘。
 *
 * 改法：
 *   · 首次使用时读一次文件进内存，之后**只改内存**（零 IO）；
 *   · 改完排一个 300ms 的延迟刷盘（多次改动自动合并成一次写）；
 *   · 出站读文件时，300ms 早已过去（LLM 响应远慢于此），不会读到旧值；
 *   · 进程退出前 flush（SIGTERM/SIGINT）兜底，避免丢最后一次。
 *
 * ⚠️ 红线：at-sender.json 是**跨扩展契约**（出站 10-ensure-at-back.mjs 读它），
 *    所以磁盘格式、key 规则、清理规则**一个字都不能变** —— 只改了"什么时候写"。
 */
const AT_SENDER_FILE = new URL('file://' + EXT_DATA + '/at-sender.json');
const AT_SENDER_FLUSH_MS = 300;
let _atSenderCache;          // undefined = 未初始化；{} = 已加载
let _atSenderTimer;
let _atSenderDirty = false;

function atSenderPath() {
  try { return fileURLToPath(AT_SENDER_FILE); } catch { return String(AT_SENDER_FILE); }
}
function readAtSender() {
  if (_atSenderCache !== undefined) return _atSenderCache;
  try {
    _atSenderCache = JSON.parse(readFileSync(AT_SENDER_FILE, 'utf8')) || {};
  } catch { _atSenderCache = {}; }
  return _atSenderCache;
}
function flushAtSender() {
  if (_atSenderTimer) { clearTimeout(_atSenderTimer); _atSenderTimer = undefined; }
  if (!_atSenderDirty) return;
  _atSenderDirty = false;
  try {
    const p = atSenderPath();
    writeFileSync(p + '.tmp', JSON.stringify(_atSenderCache));
    renameSync(p + '.tmp', p);
  } catch { /* 落盘失败不影响主链 */ }
}
function scheduleAtSenderFlush() {
  _atSenderDirty = true;
  if (_atSenderTimer) return;
  _atSenderTimer = setTimeout(() => { _atSenderTimer = undefined; flushAtSender(); }, AT_SENDER_FLUSH_MS);
  _atSenderTimer.unref?.();
}
/** 立即刷盘（测试与诊断用；正常路径不需要手动调用）。 */
export function flushAtSenderNow() { flushAtSender(); }
/** 当前缓存快照（只读，测试用）。 */
export function peekAtSender() { return { ...readAtSender() }; }
// 进程退出兜底（只挂一次）
try {
  for (const sig of ['SIGTERM', 'SIGINT', 'beforeExit']) process.once(sig, flushAtSender);
} catch { /* ignore */ }

/** 把用户可控文本压成单行并替换全角括号，避免伪造【插件提示】段 */
/** 这条消息是否带图片/表情包附件 */
function hasImage(ctx) {
  const atts = [
    ...(Array.isArray(ctx?.message?.attachments) ? ctx.message.attachments : []),
    ...(Array.isArray(ctx?.state?.quote?.attachments) ? ctx.state.quote.attachments : []),
  ];
  if (atts.length > 0) return true;
  return /-\s*Image:|\.(jpe?g|png|gif|webp|bmp)\b/i.test(String(ctx?.text ?? ''));
}

/**
 * 2026-11-02 主人要求**彻底移除心情系统**。
 *
 * 原因（主人原话）：Bot 已经具备通过上下文自然感知情绪的能力；硬性心情数值
 * （【心情·平静(0/100)】这类）反而限制发挥、甚至导致 OOC。
 *
 * 所以这里不再读 `globalThis[Symbol.for('qqbot.mood-state')]`，
 * 也不再往消息里注入任何「【心情·只读】…（N/100）」的文字。
 * 情绪交给模型从上下文自然生成（anti-ai-persona 的语感/锚点机制继续保留）。
 *
 * **不要**把这段恢复成 moodHint——要加动态状态就加"事实"，不要加数值评价。
 */

/** 这条消息是否引用了别的消息 */
function hasQuote(ctx) {
  try {
    const q = ctx?.state?.quote ?? (typeof ctx?.quoted === 'function' ? ctx.quoted() : ctx?.quoted);
    return Boolean(String(q?.text ?? '').trim());
  } catch { return false; }
}

/**
 * 点名追话窗口（2026-11-06 主人实测后加）
 *
 * 要解决的现象：主人习惯「@她 一句」+（1~5 秒后）「再补一句」，但第二句**没有 @**。
 *   `requireMention: true` 时，没 @ 的消息在 SDK 的 mentionGate 就被拦掉，
 *   **根本进不了 debounce 聚合窗口** —— 所以不管 silenceSec 调多大都救不回来。
 *   实测：08:57:21「@她 那中午你想吃啥」+ 08:57:22「群友昨天晚上干嘛了」（只隔 1 秒），
 *   她照样只回答了前半句。
 *
 * 做法：被 @ / 叫名字之后 CHASE_WINDOW_MS 内，**同一个发送者**后续的消息也一并放行。
 *   放行后它进 debounce 窗口，和那句 @ 聚合成一批，她一次就能看到两句。
 *   只追同一个人、且只在短窗口内 —— 不会把群里的无关闲聊全放进来。
 *
 * ⚠️ 窗口长度必须 ≤ 插件配置的 `behavior.debounce.silenceSec`（当前 6 秒）。
 *   原因：debounce 窗口是从「@ 那条」**开始**计时的，6 秒一到就 flush、她开始生成。
 *   若本窗口比 silenceSec 还长（比如 8 秒），第 7 秒才到的补充消息虽被放行，
 *   但那时聚合窗已关 → 它会自己开一个新回合 → **她回两次**。
 *   设成等于 silenceSec 就不会：晚于它的消息本来就不该算「追话」，交回正常门控拦掉即可。
 *   （以后若把 silenceSec 调回 3，这里要跟着改小。）
 */
const CHASE_WINDOW_MS = 6000;

/** key = `${scope}:${senderId}` → 最近一次被点名的时刻（ms） */
const _chaseAt = new Map();

function chaseKeyOf(ctx) {
  return `${String(ctx?.scope ?? '')}:${String(ctx?.message?.senderId ?? '')}`;
}

export async function onInbound(ctx, next) {
  try {
    // ── 斜杠命令最先处理（私聊/群聊都要先走这里）──
    const text = String(ctx.text ?? '');
    let cmdText = text.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trimStart();
    for (let i = 0; i < 4; i++) {
      const before = cmdText;
      cmdText = cmdText
        .replace(/^★主人\s*/u, '')
        .replace(/^(?:<@[^>]+>|@[^\s]+)\s*/u, '')
        .replace(/^／/, '/')
        .trimStart();
      if (cmdText === before) break;
    }
    if (cmdText.startsWith('/') || cmdText.startsWith('／')) {
      const normalized = cmdText.startsWith('／') ? '/' + cmdText.slice(1) : cmdText;
      if (normalized !== text) ctx.rewrite({ text: normalized, reason: '斜杠命令去前缀/归一' });
      ctx.forceWake({ reason: '斜杠命令直通' });
      return next();
    }

    // 私聊：不拦，每条都进 AI；硬性规则由角色卡负责，不再重复注入
    if (ctx.scope !== 'group') return next();

    // ── P0：只认「被 @」或「叫名字比安安」──────────────────────────
    const mentioned = ctx?.platform?.mentioned === true;
    const talkedAbout = calledByCurrentText({ ...ctx, text: cmdText });

    // ── 2026-11-06 修（「@ 错人」根因）：**每条群消息**都记 msgId → 发送者 ──
    //   病因：此前只有「被 @」才写 at-sender。`requireMention: false` 下，
    //     没 @ 的消息也会进站并可能被她回复（如主人单独发「喵喵喵」走下面的追话窗口）。
    //     出站 ensure-at-back 拿回复的 msgId 查不到 → 回落到 `m[gid]`
    //     （该群「最近一次**被 @** 的人」）→ 把「回复主人」错补成 @ 上一个 @ 她的人。
    //   实测事故（示例群）：
    //     22:50:31 群友A @她 → m[gid] = 群友A
    //     22:50:46 主人发「喵喵喵」（没 @）→ 她回「喵喵喵？…」→ 被补成 <@三月> ❌
    //   修法：**未 @ 的消息**也写 `m:<msgId>` 精确索引（带 `notMention: true`）；
    //     `m[gid]` 仍只由「被 @」更新（语义「最近被 @ 的人」不被普通消息污染）。
    //   ⚠️ 必须放在 `if (mentioned || talkedAbout)` **之外** ——
    //     否则会重蹈覆辙：追话窗口那条根本不进这个分支，记录永远不会执行。
    if (!mentioned) {
      try {
        const gid2 = String(ctx?.message?.groupOpenid ?? '');
        const sender2 = String(ctx?.message?.senderId ?? '');
        const mid2 = String(ctx?.replyTarget?.msgId ?? ctx?.message?.messageId ?? '');
        if (gid2 && sender2 && mid2) {
          // 2026-11-15：改走内存缓存（原来每条消息都 readFileSync + 原子写，压在入站链上）
          const m2 = readAtSender();
          const now2 = Date.now();
          for (const k of Object.keys(m2)) {
            if (!m2[k] || now2 - Number(m2[k].ts ?? 0) > 60 * 60 * 1000) delete m2[k];
          }
          m2['m:' + mid2] = {
            senderId: sender2,
            senderName: String(ctx?.message?.senderName ?? ''),
            msgId: mid2,
            ts: now2,
            /** 标记：本条不是 @ 消息。出站据此**不给普通回复补 @**（只用于定位"在跟谁说话"）。 */
            notMention: true,
          };
          scheduleAtSenderFlush();
        }
      } catch { /* ignore */ }
    }

    // 点名追话窗口：本条没被点名，但同一个人刚在 8 秒内点过名 → 也放行
    const chaseKey = chaseKeyOf(ctx);
    const chaseHit = (() => {
      if (mentioned || talkedAbout) return false;
      const at = _chaseAt.get(chaseKey);
      if (!at) return false;
      const age = Date.now() - Number(at);
      return age >= 0 && age <= CHASE_WINDOW_MS;
    })();

    if (mentioned || talkedAbout) {
      // 记下点名时刻，供后面的补充消息命中追话窗口
      try {
        const now = Date.now();
        for (const [k, t] of _chaseAt) {
          if (now - Number(t) > CHASE_WINDOW_MS * 2) _chaseAt.delete(k);
        }
        _chaseAt.set(chaseKey, now);
      } catch { /* ignore */ }

      // 满足 P0 → 放行给 AI；引用本身不再单独放行
      ctx.forceWake({ reason: mentioned ? '被 @ → 放行回复' : '叫名字 → 放行回复' });

      const hints = [];

      // 2026-11-02：心情系统已彻底移除，这里不再注入【心情·只读】。
      // 只保留真正需要的动态提示（P1Q 引用短号等）。

      // ── P0M：被 @ 必须回（不管内容是什么）──
      if (mentioned) {
        const sender = String(ctx?.message?.senderId ?? '');
        // 记录“最近一次被 @”的发送者，出站扩展 ensure-at-back 用它兜底补 @
        try {
          // 2026-11-15：改走内存缓存（原来每条 @ 消息都全量读盘）
          const m = readAtSender();
          const gid = String(ctx?.message?.groupOpenid ?? '');
          if (gid && sender) {
            const now = Date.now();
            for (const k of Object.keys(m)) {
              if (!m[k] || now - Number(m[k].ts ?? 0) > 60 * 60 * 1000) delete m[k];
            }
            const mid = String(ctx?.replyTarget?.msgId ?? ctx?.message?.messageId ?? '');
            const rec = { senderId: sender, senderName: String(ctx?.message?.senderName ?? ''), msgId: mid, ts: now };
            m[gid] = rec; // 兼容旧逻辑：该群最近一次被 @
            if (mid) m['m:' + mid] = rec; // 精确到这条消息，@ 多人时不会补错人
            scheduleAtSenderFlush();
          }
        } catch { /* ignore */ }
      }

      // ── P1Q：被 @ 且带引用 → 必须引用回话 ──
      if (hasQuote(ctx)) {
        hints.push('【引用】回复开头写 [rf:本条消息标签里的#短号]，再说话。');
      }

      // ── 识图：权限由 aac/guard/角色卡负责；这里只保留路径清洗 ──
      const canSeeImage = ctx.scope !== 'group' || mentioned || talkedAbout;

      // 没有直接 @ 时抹掉图片路径/链接，避免模型顺手去读；允许识图时保留本地路径
      let body = text;
      if (hasImage(ctx) && !canSeeImage) {
        body = body
          .replace(/^-\s*Image:.*$/gm, '[图片/表情包：按规则不解读]')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '（图片）');
      }

      if (hints.length) {
        try {
          ctx.rewrite({ text: `${body}\n\n${hints.join('\n\n')}`, reason: '硬性规则提示（P0M/P1Q/P1）' });
        } catch { /* rewrite 失败不影响放行 */ }
      }
      return next();
    }

    // ── 点名追话窗口：本条没 @，但同一个人才刚点过名 → 放行进站 ──
    //   放行后它会进 debounce 聚合窗口，和前面那句 @ 合成一批，她一次看到两句。
    //   这里**不注入** P0M/识图那套提示（那些只针对「本条被 @」）。
    if (chaseHit) {
      try { ctx.forceWake({ reason: '点名后追话窗口 → 放行补充消息' }); } catch { /* ignore */ }
    }

  } catch {
    /* 扩展失败不影响主链 */
  }
  return next();
}

