/**
 * idea-from-group — 群友提议检测（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人要的第三种触发：「群友说她应该有什么功能，她去做，
 *                        但是要走评估和审查，看可行吗、风险大不大」。
 *
 * ── 这个 hook 只做一件事：**记下来。** ─────────────────────────────────────
 *
 *   它不判断可行不可行 —— 那是她的活（造物时刻用 Feedback 审）。
 *   这里只负责「别让群友的提议说完就没了」。
 *
 * ── 为什么要检测而不是全记 ─────────────────────────────────────────────────
 *
 *   群里每句话都记 = 垃圾堆，她根本不会看。
 *   所以只抓「**明确指向功能**」的提议：
 *     · 触发词（能不能/建议/该有/加个…）+ 功能名词（功能/命令/工具/玩法…）
 *     · 或者明确的「要是能 xxx 就好了」
 *
 * ── 安全 ───────────────────────────────────────────────────────────────────
 *
 *   · 记的是原文，但**标记来源和是否主人**
 *   · 长度截断（防灌长文）
 *   · 同一天同一个人同一个提议只记一次（去重）
 *   · **提议 ≠ 命令** —— 她在评估时才决定做不做，这里绝不触发执行
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';

export const name = 'idea-from-group';

/** 提议的触发词（要配合下面的功能名词）。 */
const ASK_WORDS = [
  '能不能', '可不可以', '可以不可以', '建议你', '建议加', '不如加',
  '你该有', '你应该有', '你该加', '你得有', '要是能', '如果能', '如果能加',
  '加个', '加一个', '做个', '做一个', '搞个', '弄个', '来个',
];

/** 必须带的功能类名词（否则「你该休息了」也会被记）。 */
const FUNC_WORDS = [
  '功能', '命令', '工具', '玩法', '插件', '技能', '能力', '接口', '系统',
  '提醒', '签到', '抽奖', '积分', '点歌', '排行', '榜单', '查询', '统计',
];

/** 「要是能 xxx 就好了」这类句式。 */
const WISH_RE = /要?是?能[^，。！？\n]{2,40}(就好了|多好|就棒了)/;

/** 目录。 */
function ideaDir() {
  return join(WORKSPACE_ROOT, '自主', '提议');
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function textOf(ctx) {
  const m = ctx?.message ?? {};
  return String(ctx?.text ?? m.content ?? m.text ?? ctx?.content ?? '').trim();
}

function gidOf(ctx) {
  const p = ctx?.peer ?? {};
  const m = ctx?.message ?? {};
  return String(p.peerId || p.groupId || m.groupOpenid || m.groupId || ctx?.groupId || '').trim();
}

function senderOf(ctx) {
  const p = ctx?.peer ?? {};
  const m = ctx?.message ?? {};
  return String(ctx?.sender?.openid ?? p.userId ?? m.senderId ?? m.senderOpenid ?? ctx?.senderId ?? '').trim();
}

function nameOf(ctx) {
  const m = ctx?.message ?? {};
  return String(m.senderName ?? ctx?.sender?.name ?? '').trim().slice(0, 20);
}

function isOwner(ctx) {
  try {
    const v = ctx?.caps?.user?.isOwner ?? ctx?.user?.isOwner ?? ctx?.isOwner;
    return v === true;
  } catch { return false; }
}

/**
 * 判断这句话是不是「在提议加个功能」。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeIdea(text) {
  const t = String(text || '').trim();
  if (t.length < 4 || t.length > 300) return false;

  // 排除明显的问句式闲聊（「你是不是该睡了」）
  if (/该睡了|该休息|早点睡|别熬|累了/.test(t)) return false;

  // ① 「要是能 xxx 就好了」
  if (WISH_RE.test(t)) return true;

  // ② 触发词 + 功能名词，两者都要有
  const hasAsk = ASK_WORDS.some((w) => t.includes(w));
  const hasFunc = FUNC_WORDS.some((w) => t.includes(w));
  return hasAsk && hasFunc;
}

/**
 * 记一条提议（去重：同日同人同内容只记一次）。
 */
function record(entry) {
  try {
    const dir = ideaDir();
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${todayStr()}.jsonl`);

    // 去重
    if (existsSync(f)) {
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          if (o.gid && o.gid === entry.gid && o.sender === entry.sender && o.text === entry.text) return false;
        } catch { /* skip */ }
      }
    }

    appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 入站处理：只记录，绝不拦截、绝不执行。
 */
export async function onInbound(ctx, next) {
  try {
    const text = textOf(ctx);
    if (text && looksLikeIdea(text)) {
      const gid = gidOf(ctx);
      const sender = senderOf(ctx);
      if (gid) {
        record({
          at: new Date().toISOString(),
          gid: gid.slice(0, 16),        // 截短，不落完整 openid
          sender: sender ? sender.slice(-6) : '',  // 只留尾号，够她去重
          name: nameOf(ctx),
          owner: isOwner(ctx),
          text: text.slice(0, 200),
        });
      }
    }
  } catch { /* 任何异常都放行 */ }
  return next();
}

export default { name, onInbound, looksLikeIdea };
