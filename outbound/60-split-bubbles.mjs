/**
 * split-bubbles — 把一段多句回复拆成多个独立气泡（拟人化发送节奏）
 *
 * 主人要求（2026-11-01）：
 *   「Bot 输出两句话时会合并到同一个气泡里；希望像真人一样一句一个气泡，中间带点延迟。」
 *
 * 做法：
 *   · 模型按系统提示把想说的话分成几行（`\n` 分隔）；没有分行但有多句、且整体够长时，按句末标点拆；
 *   · 第一段留在本条出站（照常走完整出站链、带 @ 与引用标签），其余段落用 `ctx.send()`
 *     **在后台按 800–1500ms 随机延迟依次发送**（不占出站链预算，不拖慢第一条）；
 *   · 指令标签（[rf:] / [MEDIA:] / [RECALL]）一律只留第一段：一条消息只能引用一条，
 *     媒体与撤回指令也只发一次，绝不重复（否则 QQ 会报重复引用或重复撤图）。
 *
 * 安全边界：
 *   · 含代码块 / 表格 / 列表 / 媒体或撤回指令的回复**不拆**（拆开就散架）；
 *   · 气泡数上限 3（再多会被 QQ 判刷屏，被动回复配额也有限）；
 *   · 只处理 group / c2c 的 text / markdown；卡片、媒体段、回环调用不动；
 *   · 任何异常都放行原文本，绝不吞消息。
 *
 * 配置：{dataRoot}/.qqbot-extensions/data/split-bubbles-config.json（**缺省关闭**，见下方说明）
 *   { "enabled": false, "maxBubbles": 3, "delayMin": 800, "delayMax": 1500,
 *     "minTotalLen": 24, "minBubbleLen": 8, "splitOnPunct": true }
 * 测试可用 QQBOT_SPLIT_DELAY_MIN / QQBOT_SPLIT_DELAY_MAX 覆盖延迟。
 *
 * ⚠️ 2026-11-25 生产已关闭（`enabled: false`）
 *   现象：主动心跳回合里模型输出两段，群里只发出**最后一段**，第一段凭空消失
 *        （msg-history 无记录、台账有完整原文）。
 *   已排查：拆段逻辑本身正确（真实文本复现可拆 2 条）；出站链 45/47/50/55/56/99
 *        六个 hook 对第一段均放行；dedupe 台账记录的是拆分前完整原文。
 *   未定位：`ctx.rewrite(first)` 返回 true 但第一段未到达 QQ。
 *   决定：先关掉拆分，让整段作为单条发出，规避吞话；根因待真机加日志后再修。
 *   恢复：把 split-bubbles-config.json 的 enabled 改回 true。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { maskFaces } from '../lib/pure/face-safe.mjs';

export const name = 'split-bubbles';

const CONFIG_FILE = join(EXT_DATA, 'split-bubbles-config.json');
/**
 * 2026-11-01 真机第二次修（主人截图：`嗯，那就好。` + `那我就不追问啦～` 这种很短的两句也被拆了）：
 *   原阈值按**原始字符长度**算，而 ensure-at-back 会在正文前补 `<@XXXXXXXX…>` 这种 33 字符的 @ 标签，
 *   15 字的正文被凑成 54 字 ⇒ 轻松过 16 字门槛。改法：
 *     ① 长度一律按**可见字数**（去 @ 标签、去标点符号、只数中文/字母/数字）；
 *     ② 门槛提高到「整段可见 ≥24 字」，且**每段可见 ≥8 字**——两三个字的应答（"嗯，那就好。"
 *        "那我就不追问啦～"，可见 11 字）直接不拆，合成一句发；
 *     ③ 按句末标点自动拆的门槛再高一档（≥34 字），避免把一句完整的话硬切两半。
 *   想调就改 split-bubbles-config.json 的 minTotalLen / minBubbleLen。
 */
const DEFAULT_CONFIG = {
  // ★ 2026-11-25：默认关闭。主动心跳回合拆两段时第一段会被吞（详见文件头说明），
  //   根因未定位前不冒险。想恢复：配置里写 "enabled": true，或直接改这里。
  enabled: false,
  maxBubbles: 3,
  delayMin: 800,
  delayMax: 1500,
  minTotalLen: 24,
  minBubbleLen: 8,
  minPunctSplitLen: 34,
  splitOnPunct: true,
  // ★ 2026-11-14：同 target 多短的时间内只允许拆一次（防同回合多个正文块各拆一遍）。
  //   上游正文路径的 isLastChunk 恒 true（详见 hook 里的注释），只能靠时间窗判。
  splitDedupeMs: 1500,
};

/**
 * 「这个会话刚拆过气泡」的内存时间戳：targetKey → Date.now()。
 * 只做**去重提示**，不落盘；重启即清（重启后第一轮多拆一次无副作用）。
 * 上限 200 条，超了按时间淘汰最旧的 —— 与 10-ensure-at-back 的 atDoneTurns 同款纪律。
 */
const splitRecently = new Map();
function rememberSplit(key, now = Date.now()) {
  if (!key) return;
  splitRecently.set(key, now);
  if (splitRecently.size > 200) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [k, ts] of splitRecently) if (ts < cutoff) splitRecently.delete(k);
  }
}
/** 测试用：清掉去重窗口（生产不调用） */
export function __resetSplitDedupe() { splitRecently.clear(); }

const RF_RE = /\[rf:[^\]\s]{1,32}\]/gi;
const AT_RE = /<@[^>]+>/g;
const MEDIA_RE = /\[MEDIA:/i;
const RECALL_RE = /\[RECALL/i;
const LIST_LINE_RE = /^\s*([-*+]\s|\d+\.\s|>\s?|#{1,6}\s)/;

function readConfig() {
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
    return { ...DEFAULT_CONFIG, ...j };
  } catch { return { ...DEFAULT_CONFIG }; }
}

/** 可见字数：去掉 @ 标签、指令标签与所有标点/空白，只数中文、字母、数字。 */
export function visibleLen(s) {
  return String(s ?? '')
    .replace(AT_RE, '')
    .replace(RF_RE, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/gu, '')
    .length;
}

/** 不该拆的形态：代码块、表格、列表、引用块、媒体/撤回指令 */
function unsplittable(text) {
  const t = String(text ?? '');
  if (t.includes('```')) return true;
  if (MEDIA_RE.test(t) || RECALL_RE.test(t)) return true;
  return t.split('\n').some((l) => LIST_LINE_RE.test(l) || l.includes('|'));
}

/** 抽出指令标签（[rf:]），返回 { tags, body } */
function detachTags(text) {
  const t = String(text ?? '');
  const tags = [];
  const body = t.replace(RF_RE, (m) => { tags.push(m); return ''; });
  return { tags, body };
}

/** 片段多于上限时，把多出来的并进最后一个（保持顺序、不丢字） */
function capBubbles(parts, maxBubbles) {
  if (parts.length <= maxBubbles) return parts;
  const head = parts.slice(0, maxBubbles - 1);
  head.push(parts.slice(maxBubbles - 1).join(' '));
  return head;
}

/**
 * 纯函数：把一段正文拆成气泡数组；返回长度 <2 表示「不拆」。
 *
 * ★ 2026-11-20 适配 qqbot 1.13.18+：**先掩码表情再拆**。
 *   上游从这个版本起会把 `【表情: XX】` 换成真的 QQ face 控制字符
 *   （`U+0014` + id），而官方处理顺序是「先换表情 → 再跑出站扩展」
 *   ⇒ 我们拿到的正文里已经有裸控制字符。
 *   直接在原文上 split，可能正好切在 `U+0014` 与 id 之间 ⇒ 表情被拆散，
 *   群里显示成空白/乱码且日志无痕（上游 chunker.ts 也为此专门加了边界判定）。
 *   这里用 face-safe 掩码：拆完再按顺序还原，每个气泡独立还原。
 *
 * @param {string} text 原始正文（可含指令标签与 @ 标签）
 * @param {object} cfg 配置
 * @returns {string[]} 气泡列表（首个已带上指令标签）；不拆时返回 []
 */
export function splitIntoBubbles(text, cfg = DEFAULT_CONFIG) {
  const { text: masked, restore, faces } = maskFaces(text);
  const out = splitIntoBubblesMasked(masked, cfg);
  return faces.length ? out.map((p) => restore(p)) : out;
}

/** 拆分的纯实现（输入已掩码，不含 face 控制字符）。 */
function splitIntoBubblesMasked(text, cfg = DEFAULT_CONFIG) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  if (unsplittable(raw)) return [];
  const { tags, body } = detachTags(raw);
  const minTotal = Number(cfg.minTotalLen ?? 28);
  const minPunctSplit = Number(cfg.minPunctSplitLen ?? 34);
  const minBubble = Number(cfg.minBubbleLen ?? 8);
  // ① 整段可见字数够不够（不把 @ 标签/标点算进去）——两三个字的应答一律不拆
  if (visibleLen(body) < minTotal) return [];

  let parts = body.split('\n').map((s) => s.trim()).filter(Boolean);
  // ② 没有分行 / 只有一行 ⇒ 按句末标点拆（门槛更高，避免把一句完整的话硬切两半）
  if (parts.length < 2 && cfg.splitOnPunct !== false && visibleLen(body) >= minPunctSplit) {
    parts = body.split(/(?<=[。！？!?…])/u).map((s) => s.trim()).filter(Boolean);
  }
  // ③ 太短的碎片并回前一段（按可见字数判，@ 标签不算）
  const merged = [];
  for (const p of parts) {
    if (!p) continue;
    if (merged.length && visibleLen(p) < minBubble) merged[merged.length - 1] += p;
    else merged.push(p);
  }
  if (merged.length < 2) return [];
  const bubbles = capBubbles(merged, Math.max(1, Number(cfg.maxBubbles ?? 3)));
  if (tags.length) bubbles[0] = `${tags.join('')}${bubbles[0]}`.trim();
  return bubbles;
}

function randomDelay(cfg) {
  const min = Math.max(0, Number(process.env.QQBOT_SPLIT_DELAY_MIN ?? cfg.delayMin ?? 800));
  const max = Math.max(min, Number(process.env.QQBOT_SPLIT_DELAY_MAX ?? cfg.delayMax ?? 1500));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function targetKey(ctx) {
  const t = ctx?.target ?? {};
  const scope = String(t.scope ?? '');
  const id = String(t.targetId ?? t.peerId ?? '');
  return scope && id ? `${scope}:${id}` : '';
}

export default async function onOutbound(ctx, next) {
  try {
    const kind = String(ctx?.kind ?? 'text');
    if (kind !== 'text' && kind !== 'markdown') return next();
    const scope = String(ctx?.target?.scope ?? '');
    if (scope !== 'group' && scope !== 'c2c') return next();
    const cfg = readConfig();
    if (!cfg.enabled) return next();
    // ★ 2026-11-01 真机实测（主人截图：第二个气泡发了两遍）——**必须只在 phase='send' 里拆**。
    //   QQBot 的回合结束钩子（runOutboundTurnEnd）会把「本回合最后一块正文」**再跑一遍出站链**
    //   （phase='turnEnd' 且 isLastChunk=true），用于配图/收尾。如果我们在这里也拆一次，
    //   同一个正文会被拆两遍、第二个气泡发两遍（截图里就是连着两条一模一样的）。
    //   ⇒ turnEnd 一律直接放行（不拆、不补发）；只在正常发送的 send 阶段拆一次。
    if (String(ctx?.phase ?? 'send') !== 'send') return next();
    // 一个回合可能有多个正文块（正文→工具→正文）。只在**最后一块**拆，避免一轮刷出 6 个气泡。
    //
    // ⚠️ 2026-11-14 修（护栏失效，真 bug）：
    //   上游 `transport/outbound.js:722/726` 调 `sendRichOutbound` **只传 11 个实参、没传第 12 参
    //   `extHook`** ⇒ `makeOutboundCtx` 拿到的 `chunkIndex` 恒 0、`isLastChunk` 恒 true
    //   （只有 turnEnd 路径 outbound.js:256 才传 turnId；chunkIndex/isLastChunk 两个字段全仓无人传）。
    //   所以 `ctx.isLastChunk === false` **永远不会命中**，"只拆最后一块"这条护栏一直是空转的：
    //   一个回合里「正文→工具→正文」的两段都会被拆，一轮刷出 4~6 个气泡。
    //   替代判据：**同一 target 的 1.5 秒窗口内只拆一次**（下面 splitRecently）。
    //   比 turnId 可靠（turnId 在正文路径恒空），也比"记住本回合"轻（不需要回合生命周期钩子）。
    if (ctx?.isLastChunk === false) return next();
    const raw = String(ctx?.text ?? '');
    if (!raw.trim()) return next();

    // 同 target 极短窗口内已经拆过一次 ⇒ 这是同回合的后续正文块，直接整条发，不再拆/不再补发。
    const dedupeKey = targetKey(ctx);
    const nowMs = Date.now();
    const dedupeMs = Math.max(0, Number(cfg.splitDedupeMs ?? DEFAULT_CONFIG.splitDedupeMs));
    const lastAt = dedupeKey ? (splitRecently.get(dedupeKey) ?? 0) : 0;
    if (lastAt && nowMs - lastAt < dedupeMs) {
      try { ctx.note?.(`同回合已拆过（${nowMs - lastAt}ms 内），本块不拆`); } catch { /* ignore */ }
      return next();
    }

    const bubbles = splitIntoBubbles(raw, cfg);
    if (bubbles.length < 2) {
      // ★ 2026-11-01 主人要求「短的就合成一句，不要换行」：
      //   模型有时会用换行把两句短的断开，但内容不够长、不值得拆。这里**把换行并成一句**
      //   （顿号/逗号连接），避免 QQ 里出现一个气泡内乱七八糟的换行——那不是拟人，是排版噪音。
      //   只处理纯文本正文；带指令标签（[rf:]/[MEDIA:]/[RECALL]）的原样放行，别动标记结构。
      try {
        // ★ 2026-11-05 修（真机实锤：一条 Python 回复在群里被「，」连成一行、缩进全丢）：
      //   含 ``` 的回复在上面的 unsplittable() 里被判「不拆」，于是 bubbles.length=0，
      //   直接掉进这里被逐行用「，」拼接 —— 代码的换行和缩进全毁，像一坨乱码。
      //   代码块必须原样整条发送，**绝不参与合并**。
      if (cfg.mergeShortWithoutNewline !== false && !MEDIA_RE.test(raw) && !RECALL_RE.test(raw)
        && !raw.includes('```') && raw.includes('\n')) {
          const { tags, body } = detachTags(raw);
          const lines = body.split('\n').map((s) => s.trim()).filter(Boolean);
          if (lines.length >= 2) {
            // 拼接时按前一行结尾决定是否需要补分隔符：
            //   "嗯，那就好。" + "那我就不追问啦～" → 直接连（前句已有句末标点，再加「，」会变成「。，」）
            //   "好的呀" + "知道啦"           → 补一个「，」
            let joined = lines[0];
            for (const line of lines.slice(1)) {
              const needSep = !/[。！？!?…、，,~～\s]$/u.test(joined);
              joined += (needSep ? (cfg.mergeSeparator ?? '，') : '') + line;
            }
            const merged = `${tags.join('')}${joined}`.trim();
            if (merged !== raw) {
              ctx.rewrite(merged);
              try { ctx.note?.(`短回复合并为一句（${lines.length} 行 → 1 行）`); } catch { /* ignore */ }
            }
          }
        }
      } catch { /* 合并失败就保持原样 */ }
      return next();
    }

    const [first, ...rest] = bubbles;
    try { ctx.rewrite(first); } catch { return next(); }
    // ★ 2026-11-14：真正拆了才记窗口 —— 上面"不拆/合并"的分支不占窗口，
    //   否则同回合第一段太短没拆、第二段够长该拆时会被自己挡掉。
    rememberSplit(dedupeKey, nowMs);

    // 其余气泡：后台按随机延迟依次发；第一条照常走完整出站链（@、引用、脱敏都还在）
    //
    // ⚠️⚠️ 2026-11-24 重要修正：后续气泡走 `ctx.send()`，而它**不经过出站扩展链**
    //    （上游 ext-outbound 的 send 直接调 sendViaOutboundChannel）。
    //    后果：40-strip-tool-leaks / 42-strip-error-leaks / 45-privacy-guard /
    //          99-final-leak-check 全部**对后续气泡失效**。
    //    真实风险：今天群里泄漏的 "`FsError: FS_NOT_FOUND`" 如果被拆到第二段，
    //    就会绕过所有拦截直接发出去。
    //    ⇒ 所以**在这里补一次清理**：拆之前把每个气泡都过一遍泄漏检查。
    let safeRest = rest;
    try {
      // ⚠️ 用 import.meta.url 解析同级文件：相对 './x.mjs' 在扩展被
      //    动态装载时可能解析失败（上游用绝对路径 import，base 不一定是我们这层）。
      const leakMod = await import(pathToFileURL(join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '99-final-leak-check.mjs')).href);
      const { finalLeakCheck } = leakMod;
      safeRest = rest
        .map((b) => String(b ?? ''))
        .map((b) => finalLeakCheck(b).text)
        .filter((b) => b && b.trim());
      // 全被清光 ⇒ 不发（否则会发空消息）
      if (!safeRest.length) {
        try { ctx.note?.('后续气泡全是内部信息，已全部拦截'); } catch { /* ignore */ }
        return next();
      }
    } catch {
      // 清理模块加载失败 ⇒ 保守起见**不拆了**，只发第一段
      // （宁可少一段，也不能把没清过的内容发出去）
      try { ctx.note?.('泄漏清理模块不可用，本次不拆分'); } catch { /* ignore */ }
      return next();
    }

    try {
      ctx.background?.(async () => {
        for (const bubble of safeRest) {
          await new Promise((r) => setTimeout(r, randomDelay(cfg)));
          try { await ctx.send(bubble); } catch { /* 单条失败不影响后续 */ }
        }
      });
    } catch { /* 连调度都失败 ⇒ 只发第一条，不冒险乱序 */ }

    try { ctx.note?.(`拆成 ${bubbles.length} 个气泡 ${targetKey(ctx)}`); } catch { /* ignore */ }
  } catch { /* 任何异常都按原文发 */ }
  return next();
}
