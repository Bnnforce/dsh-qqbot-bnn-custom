/**
 * 47-anti-template — 反模板：起手撞车 / 复读开场 / 结尾撞车
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 要解决的问题
 *
 *   她连续几条都用同样的话开头（「好的」「嗯」「其实」），
 *   或者每条都以问句结尾 —— 聊得越久越像模板机。
 *
 *   现有 50-style-guard 只做**句内**重复检测，而且**只告警不改写**。
 *   本 hook 补的是**跨条**的模板化，并且**真的改写**。
 *
 * ── 为什么单独一个文件而不是塞进 style-guard ──────────────────────────────
 *
 *   · style-guard 的定位是"只告警不改语义"，塞进去会破坏那个契约
 *   · 本 hook 要**读历史台账**（recent-replies.json），是另一类依赖
 *   · 文件名 47- 排在 style-guard(50-) 之前，先削模板再过风格巡检
 *
 * ── 三条规则（都很保守，宁可漏削不可削错）───────────────────────────────
 *
 *   ① **起手撞车**：最近 3 条都以同一个 2-4 字词开头 → 本条削掉那个开头
 *   ② **复读开场**：本条前 12 字与最近 5 条任一条前 12 字相似度 ≥80% → 削掉重复部分
 *   ③ **结尾撞车**：最近 3 条都以问号结尾 → 本条去掉末尾追问句
 *
 *   ⚠️ 只做"削"，不做"重写"—— 改语义的风险太大。
 *      削完如果正文过短（<6 字）→ 放弃本次改写，原样发。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA } from '../lib/pack-paths.mjs';

export const name = 'anti-template';

const LEDGER = join(EXT_DATA, 'recent-replies.json');
const CONFIG = join(EXT_DATA, 'anti-template-config.json');

const DEFAULTS = {
  enabled: true,
  /** 起手撞车：最近几条比对。 */
  lookback: 5,
  /** 起手撞车：连续几条同开头才削。 */
  startStreak: 3,
  /** 复读开场相似度阈值。 */
  similarity: 0.8,
  /** 结尾撞车：连续几条问句结尾才削。 */
  questionStreak: 3,
  /** 削完少于这个长度就放弃改写。 */
  minKeep: 6,
};

function readJson(p, fb) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? fb; } catch { return fb; }
}

function config() {
  try {
    const c = readJson(CONFIG, null);
    return { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 从台账里取最近 N 条正文（按群隔离）。 */
function recentTexts(gid, n) {
  try {
    if (!existsSync(LEDGER)) return [];
    const j = readJson(LEDGER, {});
    // 台账结构可能是 { <gid>: [...] } 或 { <gid>: { <key>: [...] } }，两种都兼容
    const bucket = j?.[gid];
    if (!bucket) return [];
    let arr = [];
    if (Array.isArray(bucket)) arr = bucket;
    else if (typeof bucket === 'object') {
      for (const v of Object.values(bucket)) if (Array.isArray(v)) arr.push(...v);
    }
    return arr
      .map((x) => (typeof x === 'string' ? x : String(x?.text ?? x?.body ?? '')))
      .filter(Boolean)
      .slice(-n);
  } catch {
    return [];
  }
}

/**
 * 取开头 n 个字（**去掉标点和空白后**再取）。
 *
 * ⚠️ 2026-11-24 修：原来直接 slice(0,4)，会把「好的，收」和「好的，那」判成不同开头
 *    —— 逗号占了第 3 位，第 4 字必然不同 ⇒ 起手撞车规则**永远不触发**（实测）。
 *   必须先把标点去掉。
 */
/** 归一化：去标点空白，用于比较「开头是否撞车」。 */
function normalizeHead(text) {
  return String(text ?? '')
    .replace(/^[\s"'「『【（(]+/, '')
    .replace(/[\s，,、。！!？?；;：:…~～]+/g, '');
}

/** 转义正则元字符。 */
function escapeRe(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\function head(text, n = 4) {');
}

function head(text, n = 4) {
  return String(text ?? '')
    .replace(/^[\s"'「『【（(]+/, '')
    .replace(/[\s，,、。！!？?；;：:…~～]+/g, '')
    .slice(0, n);
}

/** 简单相似度：公共前缀长度 / 较短者长度。 */
function prefixRatio(a, b, n = 12) {
  const x = String(a ?? '').slice(0, n);
  const y = String(b ?? '').slice(0, n);
  if (!x || !y) return 0;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  return i / Math.min(x.length, y.length);
}

/**
 * 计算要不要改写。纯函数，方便单测。
 *
 * @param {string} text 本条正文
 * @param {string[]} recent 最近几条正文（旧→新）
 * @param {object} cfg
 * @returns {{ text: string, reasons: string[] }}
 */
export function antiTemplate(text, recent, cfg = DEFAULTS) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { text: raw, reasons: [] };

  const reasons = [];
  let out = raw;

  // ── ① 起手撞车：最近 N 条的共同前缀 ≥2 字 ──
  //
  // ⚠️ 2026-11-24 修（两次踩）：
  //   第一版比「前 4 字完全相等」→ 逗号占位，永远不等；
  //   第二版去掉标点后比 → 「好的那我」vs「好的收到」仍不等（第 3 字就分了）。
  //   正确判据是**共同前缀长度**：只要有 2 字以上共同开头就算撞车。
  const startStreak = Math.max(2, Number(cfg.startStreak) || 3);
  const lastN = recent.slice(-startStreak);
  if (lastN.length >= startStreak) {
    const heads = [normalizeHead(out), ...lastN.map((r) => normalizeHead(r))];
    // 求所有字符串的共同前缀
    let common = heads[0] || '';
    for (const h of heads.slice(1)) {
      let i = 0;
      while (i < common.length && i < h.length && common[i] === h[i]) i += 1;
      common = common.slice(0, i);
      if (!common) break;
    }
    // 共同前缀 ≥2 字才算"撞车"（1 个字太容易误判，比如都以「我」开头）
    if (common.length >= 2) {
      const cut = String(out).replace(new RegExp(`^\\s*${escapeRe(common)}[，,、\\s]*`), '');
      if (cut.trim().length >= (Number(cfg.minKeep) || 6)) {
        out = cut;
        reasons.push(`start-streak:${common}`);
      }
    }
  }

  // ── ② 复读开场：与最近某条前 12 字高度相似 ──
  const sim = Number(cfg.similarity) || 0.8;
  for (const r of recent.slice(-5)) {
    if (!r || r.length < 6) continue;
    if (prefixRatio(out, r, 12) >= sim) {
      // 削掉共同前缀（最多 12 字），但保留剩余
      const x = String(out).slice(0, 12);
      let i = 0;
      while (i < x.length && i < String(r).length && x[i] === String(r)[i]) i += 1;
      const cut = String(out).slice(i).replace(/^[，,、；;。\s]+/, '');
      if (cut.trim().length >= (Number(cfg.minKeep) || 6)) {
        out = cut;
        reasons.push('repeat-opening');
        break;
      }
    }
  }

  // ── ③ 结尾撞车：最近 N 条都以问号结尾 ──
  const qStreak = Math.max(2, Number(cfg.questionStreak) || 3);
  const lastQ = recent.slice(-qStreak);
  if (lastQ.length >= qStreak && lastQ.every((r) => /[?？]\s*$/.test(String(r).trim()))) {
    // 去掉**最后一个问句分句**（按标点切段，只删最后一段）。
    //
    // ⚠️ 2026-11-24 修：原来用 /[^。！？!?]*[?？]$/ —— 逗号不在排除集里，
    //   它把「这件事我同意了，那你觉得呢？」**整句**匹配掉 ⇒ 削完是空串 ⇒ 放弃改写。
    //   正确做法：按标点切段，只在最后一段是问句时删掉它。
    const segs = String(out).split(/(?<=[。！？!?，,；;])/).filter((x) => String(x).trim());
    const lastSeg = String(segs[segs.length - 1] ?? '');
    const cut = /[?？]\s*$/.test(lastSeg) && segs.length > 1
      ? segs.slice(0, -1).join('').replace(/[，,；;\s]+$/, '').trim()
      : '';
    if (cut.length >= (Number(cfg.minKeep) || 6)) {
      out = cut;
      reasons.push('question-streak');
    }
  }

  return { text: out, reasons };
}

function gidOf(ctx) {
  const t = ctx?.target ?? {};
  return String(t.targetId ?? t.peerId ?? ctx?.peer?.peerId ?? '').trim();
}

export default async function onOutbound(ctx, next) {
  try {
    const cfg = config();
    if (cfg.enabled === false) return next();

    const raw = String(ctx?.text ?? '');
    if (!raw.trim()) return next();

    const gid = gidOf(ctx);
    const recent = gid ? recentTexts(gid, Math.max(5, Number(cfg.lookback) || 5)) : [];

    // ★ 2026-11-24 克制原则（照抄 42-strip-error-leaks / 99-final-leak-check）：
    //   规则表在 ONE place，`kind='line'` 必填 —— 只删整行、不删正文里的正常句。
    //   宁可漏削，不可削错。
    const lines = String(raw).split('\n');
    const kept = [];
    let dropped = 0;
    const hits = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) { kept.push(line); continue; }
      // 内部标识/路径类（与 99 同一清单，保持单一出处）
      const isInternal =
        /^(?:FS_NOT_FOUND|ENOENT|EACCES|ETIMEDOUT|ERR_MODULE_NOT_FOUND|TOOL_TIMEOUT)\b/.test(t) ||
        /^[A-Z][A-Za-z0-9_]*(?:Error|Exception)\s*:/.test(t) ||
        /^(?:\/data|\/storage|\/sdcard)\/\S+$/.test(t) ||
        /^(?:entities|groups|events|people)\/[\w.-]+\.md$/.test(t);
      if (isInternal) { dropped += 1; hits.push('internal'); continue; }
      kept.push(line);
    }
    const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!cleaned) {
      try { ctx.annihilate?.('正文全是内部信息，已拦截（anti-template 兜底）'); } catch { /* ignore */ }
      return;
    }
    let out = cleaned;
    if (dropped) {
      try { ctx.note?.(`anti-template: 清理 ${dropped} 行内部信息`); } catch { /* ignore */ }
    }

    const r = antiTemplate(out, recent, cfg);
    if (r.reasons.length && r.text !== out) {
      out = r.text;
      try { ctx.note?.(`反模板：${r.reasons.join(',')}`); } catch { /* ignore */ }
    }

    if (out !== raw) {
      try { ctx.rewrite?.(out); } catch { /* ignore */ }
    }
    return next();
  } catch {
    // 任何异常都原样放行（宁可模板化，不可丢消息）
    return next();
  }
}
