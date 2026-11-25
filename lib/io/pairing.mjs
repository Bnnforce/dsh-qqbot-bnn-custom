/**
 * pairing.mjs — 「/随心配」核心逻辑（外挂扩展，不改主插件）
 *
 * 主人 2026-10-20 定：
 *   · 冷静期 3 秒；配对按群隔离；候选池=本群发过言的成员；配对 24 小时自动过期；
 *   · 成功消息用 Markdown 卡片（msg_type=2），双方 @ + 头像 + 昵称；
 *   · 卡片里带「取消配对」按钮；昵称只用群友自己的名字，不显示 openid。
 *
 * 目录推导：本文件位于 {dataRoot}/.qqbot-extensions/lib/ → dataRoot 为上一级。
 */
import {
  mkdirSync, readFileSync, writeFileSync, renameSync,
  openSync, closeSync, unlinkSync, existsSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { DATA_ROOT as PACK_DATA_ROOT, EXT_DATA } from '../pack-paths.mjs';

export const DATA_ROOT = PACK_DATA_ROOT;
const DATA_DIR = EXT_DATA;
const STORE_FILE = join(DATA_DIR, 'pairings.json');
const LOCK_FILE = join(DATA_DIR, 'pairings.lock');
const REGISTRY_FILE = join(DATA_ROOT, '.qqbot', 'ext-tool-cards.json');
const LEDGER_FILE = () => join(DATA_ROOT, '表情包', 'group-members.jsonl');

export const COOLDOWN_MS = 3_000;
export const PAIR_TTL_MS = 24 * 3600_000;
export const TOOL_NAME = 'pairing';

/* ───────────────────────── 基础存储 ───────────────────────── */

function emptyState() {
  return { version: 1, pairs: {}, cooldown: {}, members: {}, seq: 0 };
}

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch { /* ignore */ }
}

export function loadState() {
  ensureDir(DATA_DIR);
  let st;
  try { st = JSON.parse(readFileSync(STORE_FILE, 'utf8')); } catch { st = null; }
  const s = st && typeof st === 'object' ? st : {};
  return {
    version: 1,
    pairs: s.pairs && typeof s.pairs === 'object' ? s.pairs : {},
    cooldown: s.cooldown && typeof s.cooldown === 'object' ? s.cooldown : {},
    members: s.members && typeof s.members === 'object' ? s.members : {},
    seq: Number(s.seq) || 0,
  };
}

export function saveState(st) {
  ensureDir(DATA_DIR);
  const tmp = `${STORE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  renameSync(tmp, STORE_FILE);
}

/** 清掉过期配对（24h）与过期冷静期 */
export function prune(st, now = Date.now()) {
  let changed = false;
  for (const gid of Object.keys(st.pairs)) {
    const arr = Array.isArray(st.pairs[gid]) ? st.pairs[gid] : [];
    const kept = arr.filter((p) => p && Number(p.at) + PAIR_TTL_MS > now);
    if (kept.length !== arr.length) { st.pairs[gid] = kept; changed = true; }
    if (kept.length === 0) delete st.pairs[gid];
  }
  for (const k of Object.keys(st.cooldown)) {
    if (Number(st.cooldown[k]) <= now) { delete st.cooldown[k]; changed = true; }
  }
  return changed;
}

/* ───────────────────────── 进程内 + 文件锁 ───────────────────────── */

let chain = Promise.resolve();

function acquireFileLock(timeoutMs = 5_000) {
  ensureDir(DATA_DIR);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, 'wx');
      closeSync(fd);
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') return false;
      try {
        const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
        if (age > 10_000) { try { unlinkSync(LOCK_FILE); } catch { /* ignore */ } }
      } catch { /* ignore */ }
      if (Date.now() > deadline) return false;
      // 同步等待 20ms（本模块在异步链里调用，用 Atomics 不好，直接忙等极短）
      const end = Date.now() + 20;
      while (Date.now() < end) { /* spin */ }
    }
  }
}

function releaseFileLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

/** 串行执行（进程内排队 + 文件锁兜底多实例） */
export async function withLock(fn) {
  const run = async () => {
    const ok = acquireFileLock();
    try {
      return await fn();
    } finally {
      if (ok) releaseFileLock();
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/* ───────────────────────── 群成员台账 ───────────────────────── */

/** 本群发过言的成员：mid → 最近一次 name（按 ts 覆盖） */
export function groupMembers(gid, root = DATA_ROOT) {
  const file = join(root, '表情包', 'group-members.jsonl');
  const map = new Map();
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let d;
      try { d = JSON.parse(ln); } catch { continue; }
      if (String(d.gid) !== String(gid)) continue;
      const mid = String(d.mid ?? '');
      if (!mid) continue;
      const prev = map.get(mid);
      const ts = Number(d.ts) || 0;
      const name = String(d.name ?? '').trim();
      if (!prev || ts >= prev.ts) map.set(mid, { mid, ts, name: name || prev?.name || '' });
    }
  } catch { /* 台账不存在 = 空池 */ }
  return map;
}

export function memberName(gid, mid, fallback = '') {
  const m = groupMembers(gid).get(String(mid));
  return (m?.name || fallback || '群友').trim();
}

/* ───────────────────────── 配对逻辑 ───────────────────────── */

function pairId(st) {
  st.seq = (Number(st.seq) || 0) + 1;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `P${rand}`;
}

function findPairOf(st, gid, openid) {
  const arr = Array.isArray(st.pairs[gid]) ? st.pairs[gid] : [];
  return arr.find((p) => p && (p.a === openid || p.b === openid)) ?? null;
}

/** 冷却中返回剩余毫秒，否则 0 */
function cooldownLeft(st, gid, openid, now = Date.now()) {
  const until = Number(st.cooldown[`${gid}:${openid}`] || 0);
  return until > now ? until - now : 0;
}

/**
 * 执行 /随心配（调用方需在 withLock 内）
 * @returns {{ok:boolean, code?:string, msg?:string, pair?:object, bName?:string}}
 */
export function doPair(st, gid, openid, name) {
  const now = Date.now();
  const cd = cooldownLeft(st, gid, openid, now);
  if (cd > 0) return { ok: false, code: 'cooldown', msg: `请稍后再试（${Math.ceil(cd / 1000)} 秒）` };
  if (findPairOf(st, gid, openid)) return { ok: false, code: 'already', msg: '你已有配对对象，请先发送 /取消配对' };

  const members = groupMembers(gid);
  const paired = new Set();
  for (const p of (st.pairs[gid] ?? [])) { if (p?.a) paired.add(p.a); if (p?.b) paired.add(p.b); }

  const cands = [];
  for (const [mid, info] of members) {
    if (!mid || mid === openid) continue;
    if (paired.has(mid)) continue;
    if (cooldownLeft(st, gid, mid, now) > 0) continue;
    cands.push({ mid, name: (info.name || '').trim() });
  }
  if (cands.length === 0) return { ok: false, code: 'empty', msg: '没有可配对群友' };

  const pick = cands[Math.floor(Math.random() * cands.length)];
  const p = {
    id: pairId(st),
    a: openid,
    b: pick.mid,
    aName: (name || '').trim(),
    bName: pick.name,
    at: now,
  };
  const arr = Array.isArray(st.pairs[gid]) ? st.pairs[gid] : [];
  arr.push(p);
  st.pairs[gid] = arr;
  return { ok: true, pair: p, bName: pick.name };
}

/**
 * 执行 /取消配对（调用方需在 withLock 内）
 * @returns {{ok:boolean, code?:string, msg?:string, partnerName?:string}}
 */
export function doCancel(st, gid, openid) {
  const p = findPairOf(st, gid, openid);
  if (!p) return { ok: false, code: 'none', msg: '你当前没有配对' };
  const arr = (st.pairs[gid] ?? []).filter((x) => x !== p);
  if (arr.length) st.pairs[gid] = arr; else delete st.pairs[gid];

  const partnerId = p.a === openid ? p.b : p.a;
  const partnerName = p.a === openid ? (p.bName || '') : (p.aName || '');
  st.cooldown[`${gid}:${openid}`] = Date.now() + COOLDOWN_MS;
  return { ok: true, partnerId, partnerName: partnerName || memberName(gid, partnerId) };
}

/** 查询某人当前配对（不修改） */
export function findPair(st, gid, openid) {
  return findPairOf(st, gid, openid);
}

/* ───────────────────────── 头像 / 卡片 ───────────────────────── */

/** appid：优先环境变量，其次读 QQ 设置文件，最后兜底空串（绝不硬编码真实 appid） */
export function resolveAppId() {
  const envId = String(process.env.QQBOT_APPID || process.env.QQ_BOT_APPID || '').trim();
  if (envId) return envId;
  try {
    const p = join(homedir(), '.dsh', 'qqbot-settings', 'web', 'im-qqbot-2.json');
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (d?.appId) return String(d.appId);
  } catch { /* ignore */ }
  // ★ 开源规范：拿不到 appid 就返回空串，让头像 URL 缺 appid（降级为占位），
  //   绝不把某个部署的真实 appid 写进代码里。
  return '';
}

export function avatarUrl(openid, size = 640, appid = resolveAppId()) {
  return `https://thirdqq.qlogo.cn/qqapp/${encodeURIComponent(appid)}/${encodeURIComponent(openid)}/${size}`;
}

/** 成功卡片（Markdown，msg_type=2） */
export function buildPairCard({ a, b, pairId, at, appid }) {
  const t = new Date(at || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const when = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const id = String(pairId || '');
  return [
    '# 💞 随心配成功',
    '',
    // 头像会由事件模块合成一张 100×100 横向图单独发送（手机端卡片里的远程图会被吞）。
    // 卡片正文只保留名字、连接线和编号。
    `**${a.name}**　━━━━💞━━━━　**${b.name}**`,
    '',
    `> 左：发起方　右：被配对方`,
    '',
    `配对编号：\`${id}\`　时间：${when}`,
    `> 想解除请点下方「💔 取消配对」，或 @我 发送 /取消配对`,
  ].join('\n');
}

/** 卡片按钮（type=1 回调按钮，所有人可点） */
export function buildKeyboard(pairId) {
  return {
    content: {
      rows: [
        {
          buttons: [
            {
              id: 'cancel',
              render_data: { label: '💔 取消配对', visited_label: '💔 取消配对', style: 4 },
              action: {
                type: 1,
                permission: { type: 2 },
                data: `ext:${TOOL_NAME}:${pairId}:cancel`,
                unsupport_tips: '请升级QQ客户端后重试',
              },
            },
          ],
        },
      ],
    },
  };
}

/* ───────────────────────── 交互卡片注册表 ───────────────────────── */

/** 写 {dataRoot}/.qqbot/ext-tool-cards.json（与插件 registerExtToolCard 同格式） */
export function registerCard(toolName, cardId, gid, expireAt, buttonIds) {
  try {
    ensureDir(dirname(REGISTRY_FILE));
    let table = { version: 1, cards: [] };
    try {
      const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
      if (raw && Array.isArray(raw.cards)) table = raw;
    } catch { /* ignore */ }
    const now = Date.now();
    // 清过期 + 去重（同一张卡重复登记会无限涨；也防两个进程同时写丢更新后重复）
    table.cards = table.cards.filter((c) => Number(c.expireAt || 0) > now
      && !(String(c?.toolName) === String(toolName) && String(c?.cardId) === String(cardId)));
    // 上限保护：只留最近 300 条
    if (table.cards.length > 300) table.cards = table.cards.slice(table.cards.length - 300);
    table.cards.push({
      toolName: String(toolName),
      cardId: String(cardId),
      buttonIds: Array.isArray(buttonIds) && buttonIds.length ? buttonIds.map(String) : ['cancel'],
      scope: 'group',
      targetId: String(gid),
      createdAt: now,
      expireAt: Number(expireAt) || now + PAIR_TTL_MS,
    });
    const tmp = `${REGISTRY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(table, null, 2), 'utf8');
    renameSync(tmp, REGISTRY_FILE);
    return true;
  } catch {
    return false; // 登记失败不影响发卡
  }
}

/** 配对卡注册（toolName=pairing，按钮 cancel） */
export function registerPairCard(cardId, gid, expireAt) {
  return registerCard(TOOL_NAME, cardId, gid, expireAt, ['cancel']);
}
