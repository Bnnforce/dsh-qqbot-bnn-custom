/**
 * group-badge/collection — 她的收藏夹（R7 Stage 5，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 隐私边界（先读这条）：
 *
 *   · 只收藏**群里的公开发言**，不收藏私聊
 *   · `/翻收藏` **只给主人看**，群友敲这个命令会被拒
 *   · 不记录「谁说的」（收藏条目只存文本 + 时间，不存 openid）
 *
 *   为什么这么保守：收藏别人的话，即使出发点是好的，也可能让人不舒服。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 全部零 LLM，用关键词 + 长度过滤。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXT_DATA } from '../pack-paths.mjs';

/** 收藏根目录。 */
export const COLLECTION_ROOT = join(EXT_DATA, 'collection');

/** 金句候选关键词（出现这些词说明这句话「有味道」）。 */
export const QUOTE_MARKERS = Object.freeze([
  '笑死', '绝了', '太真实', '说得好', '有道理', '破防', '泪目',
  '经典', '这句', '记住了', '太对了', '真理', '名言',
]);

/** 收藏条件。 */
export const COLLECT_RULES = Object.freeze({
  /** 最短长度（太短没信息量）。 */
  minLen: 12,
  /** 最长长度（太长没记忆点）。 */
  maxLen: 80,
  /** 每群最多留多少条（超出删最旧的）。 */
  maxPerGroup: 200,
});

/**
 * 判断一条消息值不值得收藏（纯函数）。
 *
 * @param {{x:string, s?:string}} msg
 * @returns {{keep:boolean, reason:string}}
 */
export function shouldCollect(msg) {
  const text = String(msg?.x ?? '').trim();
  if (!text) return { keep: false, reason: 'empty' };
  if (text.length < COLLECT_RULES.minLen) return { keep: false, reason: 'too-short' };
  if (text.length > COLLECT_RULES.maxLen) return { keep: false, reason: 'too-long' };
  // 纯符号/纯表情不收
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)) return { keep: false, reason: 'no-content' };
  // 必须命中至少一个「有味道」标记
  const hit = QUOTE_MARKERS.find((m) => text.includes(m));
  if (!hit) return { keep: false, reason: 'no-marker' };
  return { keep: true, reason: hit };
}

/** 收藏文件路径。 */
export function collectionFile(gid) {
  return join(COLLECTION_ROOT, `${String(gid ?? '').replace(/[^0-9A-Fa-f]/g, '')}.jsonl`);
}

/**
 * 收藏一条（幂等：同样文本同一天不重复收）。
 *
 * @param {string} gid
 * @param {{x:string, t?:number}} msg
 * @param {{root?:string}} [opts]
 * @returns {{added:boolean, reason:string}}
 */
export function addToCollection(gid, msg, opts = {}) {
  const check = shouldCollect(msg);
  if (!check.keep) return { added: false, reason: check.reason };

  const root = String(opts.root || COLLECTION_ROOT);
  const file = join(root, `${String(gid ?? '').replace(/[^0-9A-Fa-f]/g, '')}.jsonl`);
  try {
    mkdirSync(root, { recursive: true });

    // 幂等检查：同文本已收过就跳过
    const existing = readCollection(gid, { root });
    const text = String(msg.x).trim();
    if (existing.some((x) => x.text === text)) {
      return { added: false, reason: 'duplicate' };
    }

    // ★ 只存文本 + 时间，**不存 openid**
    const row = { at: Number(msg.t) || Date.now(), text };
    appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return { added: true, reason: check.reason };
  } catch {
    return { added: false, reason: 'write-failed' };
  }
}

/**
 * 读收藏列表。
 *
 * @param {string} gid
 * @param {{root?:string, limit?:number}} [opts]
 * @returns {Array<{at:number, text:string}>}
 */
export function readCollection(gid, opts = {}) {
  const root = String(opts.root || COLLECTION_ROOT);
  const file = join(root, `${String(gid ?? '').replace(/[^0-9A-Fa-f]/g, '')}.jsonl`);
  if (!existsSync(file)) return [];
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }

  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      // 只认合法形状（防脏数据）
      if (typeof j?.text === 'string' && j.text) out.push({ at: Number(j.at) || 0, text: j.text });
    } catch { /* 跳过坏行 */ }
  }

  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
  const sorted = out.sort((a, b) => b.at - a.at);
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

/**
 * 随机挑几条（给 `/翻收藏` 用）。
 *
 * @param {string} gid
 * @param {number} [count]
 * @param {{root?:string, rand?:()=>number}} [opts]
 * @returns {Array<{at:number, text:string}>}
 */
export function pickRandom(gid, count = 3, opts = {}) {
  const all = readCollection(gid, { root: opts.root });
  if (!all.length) return [];
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const n = Math.min(Math.max(1, Number(count) || 3), all.length);

  // Fisher-Yates 部分洗牌
  const copy = [...all];
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(rand() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export default {
  COLLECTION_ROOT, QUOTE_MARKERS, COLLECT_RULES,
  shouldCollect, collectionFile, addToCollection, readCollection, pickRandom,
};
