/**
 * slang/extract — 从群聊记录里挖掘候选黑话
 *
 * ★ 核心设计（2026-11-16）：
 *   **纯自动挖掘不可靠**，必须"自动候选 + 人工确认"。
 *   实测 879 条真实消息，不过滤时前 6 名有 5 个是系统注入文本。
 *   ⇒ 本模块只产出「候选」，绝不直接写「已确认黑话」。
 *
 * 三道过滤（顺序重要）：
 *   ① 发送者过滤：排除机器人自己（s === 'self'）
 *   ② 系统文本过滤：排除我们注入的提示（SYSTEM_TEXT_PATTERNS）
 *   ③ 格式过滤：排除纯媒体、剥掉 @ / 链接 / 标记
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIN_OCCURRENCES, SYSTEM_TEXT_PATTERNS, COMMON_WORDS, LOOKBACK_DAYS, GID_PATTERN,
} from './config.mjs';

/** 清理一条消息文本；返回 '' 表示该条应被丢弃。 */
export function cleanMessage(raw) {
  if (!raw || typeof raw !== 'object') return '';
  // ① 发送者过滤：机器人自己发的
  if (raw.s === 'self') return '';
  if (String(raw.n || '') === '机器人') return '';

  let x = String(raw.x || '');
  if (!x) return '';

  // ② 系统文本过滤（在剥离标记之前判定，因为特征在原文里）
  for (const re of SYSTEM_TEXT_PATTERNS) {
    if (re.test(x)) return '';
  }

  // ③ 格式剥离
  x = x.replace(/<@!?[0-9A-Fa-f]+>/g, '')     // @ 标记
    .replace(/★主人\s*/g, '')                  // 主人标记
    .replace(/https?:\/\/\S+/g, '')            // 链接
    .replace(/\[[^\]]{1,12}\]/g, '')           // [image] / [表情: xx] 这类
    .replace(/\s+/g, ' ')
    .trim();

  // 剥离后如果太短或太长，丢弃（太短没信息，太长多半是粘贴内容）
  if (x.length < 2 || x.length > 40) return '';

  // 再跑一次系统特征（有些污染是剥离后才露出来的）
  for (const re of SYSTEM_TEXT_PATTERNS) {
    if (re.test(x)) return '';
  }
  return x;
}

/** 从一段文本里抽 2-4 字中文片段。 */
export function extractWords(text) {
  const out = [];
  for (const m of String(text).matchAll(/[\u4e00-\u9fa5]{2,4}/g)) out.push(m[0]);
  return out;
}

/**
 * 扫描某群最近的历史，返回候选词表。
 *
 * @param {string} historyRoot  msg-history 根目录
 * @param {string} gid          群 openid（32 位十六进制）
 * @param {object} opts         { lookbackDays, minOccurrences }
 * @returns {{ ok: boolean, words: Array<{word,count,samples}>, scanned: number, reason?: string }}
 */
export function mineCandidates(historyRoot, gid, opts = {}) {
  const lookbackDays = Number(opts.lookbackDays) > 0 ? Number(opts.lookbackDays) : LOOKBACK_DAYS;
  const minOcc = Number(opts.minOccurrences) > 0 ? Number(opts.minOccurrences) : MIN_OCCURRENCES;

  // ★ 防路径穿越：gid 必须严格匹配
  if (!GID_PATTERN.test(String(gid || ''))) {
    return { ok: false, words: [], scanned: 0, reason: 'gid 非法' };
  }
  const dir = join(historyRoot, `group_${gid}`);
  if (!existsSync(dir)) {
    return { ok: false, words: [], scanned: 0, reason: '该群没有历史记录' };
  }

  // 取最近 N 天的文件（文件名是 YYYY-MM-DD.jsonl，可直接排序）
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-lookbackDays);
  } catch {
    return { ok: false, words: [], scanned: 0, reason: '读取目录失败' };
  }

  const freq = new Map();
  const sample = new Map();
  let scanned = 0;

  for (const f of files) {
    let raw = '';
    try { raw = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const text = cleanMessage(e);
      if (!text) continue;
      scanned++;
      for (const w of extractWords(text)) {
        if (COMMON_WORDS.has(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
        if (!sample.has(w)) sample.set(w, `${e.n || '?'}: ${text.slice(0, 24)}`);
      }
    }
  }

  const words = [...freq.entries()]
    .filter(([, n]) => n >= minOcc)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ word, count, samples: sample.get(word) || '' }));

  return { ok: true, words, scanned };
}
