/**
 * dedupe-replies — 出站去重 + 「最近回复」台账（硬性规则 P0R）
 *
 * ① 同会话 8 秒内完全相同的正文 → annihilate 丢弃；
 * ② 2 分钟内同一段长回复 → 视为复读，丢弃；
 * ③ 最近回复台账 + lastSentFingerprint：成功发送后落盘，重启仍能恢复去重窗口；
 * ④ 开场相似告警：默认只写 dedupe-style.jsonl，不拦截、不改正文。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXT_DATA } from '../lib/pack-paths.mjs';

export const name = 'dedupe-replies';

const DATA_DIR = EXT_DATA;
const STORE_FILE = join(DATA_DIR, 'recent-replies.json');
const STYLE_FILE = join(DATA_DIR, 'dedupe-style.jsonl');
const STYLE_CONFIG = join(DATA_DIR, 'dedupe-style-config.json');
const DEDUPE_MS = 8_000;
const STALE_MS = 120_000;
const STALE_MIN_LEN = 16;
const KEEP = 5;
const FIXED_REPLIES = new Set(['知道啦主人', '好，恢复啦']);
const SENDER_KEY = Symbol.for('qqbot.current-sender');

function currentSenderOf(scope, peerId) {
  try {
    const m = globalThis[SENDER_KEY];
    const e = m instanceof Map ? m.get(`${scope}:${peerId}`) : null;
    return e && e.senderId ? String(e.senderId) : '';
  } catch { return ''; }
}
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) || fallback; } catch { return fallback; }
}
function readStore() { return readJson(STORE_FILE, {}); }
function writeStore(store) {
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    const tmp = `${STORE_FILE}.tmp.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(store), 'utf8');
    renameSync(tmp, STORE_FILE);
  } catch { /* 写失败不影响发送 */ }
}
function styleConfig() {
  const c = readJson(STYLE_CONFIG, {});
  return {
    enabled: c?.enabled !== false,
    block: c?.block === true,
  };
}
function norm(text) {
  return String(text ?? '').trim()
    .replace(/\s+/g, ' ')
    .replace(/[♡❤️！!。.，,、…~～？?]/g, '')
    .trim();
}
function fingerprintOf(text) {
  return createHash('sha1').update(norm(text)).digest('hex').slice(0, 16);
}
/** 开场：前 6 个中文字符或前 12 个字符；去标点/表情/空白 */
function openingOf(text) {
  const clean = String(text ?? '')
    .replace(/<@[^>]+>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[\p{P}\p{S}\p{Emoji_Presentation}\s]/gu, '');
  const cjk = [...clean].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
  return (cjk.length >= 2 ? cjk.slice(0, 6).join('') : [...clean].slice(0, 12).join('')).trim();
}
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const setA = new Set([...a]);
  const setB = new Set([...b]);
  let common = 0;
  for (const ch of setA) if (setB.has(ch)) common++;
  return common / Math.max(setA.size, setB.size);
}
function logStyle(row) {
  try {
    mkdirSync(dirname(STYLE_FILE), { recursive: true });
    appendFileSync(STYLE_FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* 诊断失败不影响发送 */ }
}

export default async function onOutbound(ctx, next) {
  let record = null;
  let store = null;
  let key = '';
  let personKey = '';
  try {
    const kind = String(ctx?.kind ?? 'text');
    if (kind !== 'text' && kind !== 'markdown') return next();

    const text = String(ctx?.text ?? '').trim();
    if (text.length < 2) return next();
    if (FIXED_REPLIES.has(text) || FIXED_REPLIES.has(text.replace(/^(?:\s*<@[^>]+>)+\s*/, '').trim())) return next();

    const scope = String(ctx?.target?.scope ?? '');
    const peerId = String(ctx?.target?.targetId ?? ctx?.target?.peerId ?? '');
    if (!scope || !peerId) return next();
    key = `${scope}:${peerId}`;
    const senderId = currentSenderOf(scope, peerId);
    personKey = scope === 'group' && senderId ? `p:group:${peerId}:${senderId}` : '';

    store = readStore();
    const list = Array.isArray(store[key]) ? store[key] : [];
    const now = Date.now();
    const n = norm(text);
    const fp = fingerprintOf(text);

    // ① 8 秒内完全相同 → 丢弃
    const dup = list.find((e) => e && e.n === n && now - Number(e.at || 0) < DEDUPE_MS);
    if (dup) {
      try { ctx.annihilate?.(`P0R：${DEDUPE_MS / 1000} 秒内同一会话重复出站，已丢弃`); } catch { /* ignore */ }
      return;
    }
    // ①-b 2 分钟内同一段长回复 → 丢弃
    if (n.length >= STALE_MIN_LEN) {
      const stale = list.find((e) => e && e.n === n && now - Number(e.at || 0) < STALE_MS);
      if (stale) {
        try { ctx.annihilate?.(`防错位：${STALE_MS / 1000} 秒内同一段长回复重复出站，已丢弃`); } catch { /* ignore */ }
        return;
      }
    }

    // ③ 相似开场告警（只告警；不拦截、不改正文）
    const cfg = styleConfig();
    if (cfg.enabled) {
      const prev = (Array.isArray(store[personKey || key]) ? store[personKey || key] : []).slice(-4);
      const op = openingOf(text);
      if (op) {
        for (const e of prev) {
          if (!e?.t) continue;
          const sim = similarity(op, openingOf(e.t));
          if (sim >= 0.7) {
            logStyle({
              timestamp: new Date().toISOString(),
              peer: personKey || key,
              similarity: Number(sim.toFixed(2)),
              excerpt: text.slice(0, 80),
              action: 'alert',
            });
            break;
          }
        }
      }
    }

    record = { t: text.slice(0, 200), n, at: now, fp };
  } catch {
    /* 出站去重失败不影响发送 */
  }

  // 真正发送完成后再写台账，并记录 lastSentFingerprint
  const result = await next();

  if (record && store && key) {
    try {
      const fresh = readStore() || {};
      const list = Array.isArray(fresh[key]) ? fresh[key] : [];
      list.push(record);
      fresh[key] = list.slice(-KEEP);
      if (personKey) {
        const plist = Array.isArray(fresh[personKey]) ? fresh[personKey] : [];
        plist.push(record);
        fresh[personKey] = plist.slice(-KEEP);
      }
      fresh.lastSentFingerprint = {
        session: key,
        fingerprint: record.fp,
        at: record.at,
      };
      const keys = Object.keys(fresh).filter((k) => !k.startsWith('lastSent'));
      if (keys.length > 400) {
        for (const k of keys.slice(0, keys.length - 400)) delete fresh[k];
      }
      writeStore(fresh);
    } catch { /* ignore */ }
  }
  return result;
}
