/**
 * random-image.mjs — 从工作区美图库随机挑一张图
 *
 * 目录优先级（自动）：
 *   1) {workspace}/美图库          ← 主人放图的地方（有图就只从这里抽）
 *   2) {workspace}/美图
 *   3) {workspace}/imgwork
 *   4) {dataRoot}/美图库
 *   5) {dataRoot}/表情包/lib/candidate  ← 现有表情包图库（兜底）
 *   6) {dataRoot}/表情包
 *
 * 可用 {dataRoot}/.qqbot-extensions/data/random-image-config.json 覆盖：
 *   { "dirs": ["绝对路径或相对工作区路径", ...], "recursive": true }
 *
 * 只收 jpg/jpeg/png/gif/webp；跳过隐藏文件、>9.5MB（QQ 媒体上传上限 10MB）、空文件、符号链接。
 * 同一对话最近 5 张不重复（历史落盘，重启也记得）。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

import { DATA_ROOT as PACK_DATA_ROOT, EXT_DATA } from '../pack-paths.mjs';

const DATA_ROOT = PACK_DATA_ROOT;
const WORKSPACE = dirname(DATA_ROOT);
const DATA_DIR = EXT_DATA;
const CONFIG_FILE = join(DATA_DIR, 'random-image-config.json');
const HISTORY_FILE = join(DATA_DIR, 'random-image-history.json');

const EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MAX_BYTES = 9.5 * 1024 * 1024;
const RECENT_PER_CHAT = 5;
const MAX_HISTORY_PER_CHAT = 20;
const SCAN_TTL_MS = 30_000;

let cached = { at: 0, dirs: [], images: [] };
const lastSent = new Map(); // chatKey -> ms，简单冷却

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  } catch { /* ignore */ }
}

function loadHistory() {
  const raw = readJson(HISTORY_FILE, {});
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return {};
}
const history = loadHistory();
function saveHistory() {
  // 限制每个 key 的长度，防止无限膨胀
  for (const k of Object.keys(history)) {
    if (!Array.isArray(history[k])) history[k] = [];
    history[k] = history[k].slice(-MAX_HISTORY_PER_CHAT);
  }
  writeJsonAtomic(HISTORY_FILE, history);
}

function loadConfig() {
  const cfg = readJson(CONFIG_FILE, null);
  if (cfg && typeof cfg === 'object') {
    const dirs = Array.isArray(cfg.dirs) ? cfg.dirs.map(String).filter(Boolean) : [];
    const recursive = cfg.recursive !== false;
    if (dirs.length) return { dirs: dirs.map((d) => resolve(WORKSPACE, d)), recursive };
  }
  return { dirs: null, recursive: true };
}

function collectImages(dir, recursive, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue; // .pending-* 等隐藏文件
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (recursive) collectImages(full, recursive, out);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = ent.name.slice(ent.name.lastIndexOf('.')).toLowerCase();
    if (!EXTS.has(ext)) continue;
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_BYTES) continue;
      out.push(full);
    } catch { /* skip */ }
  }
}

/** 找到有图的第一层目录；返回 { dirs, images } */
function scan() {
  const cfg = loadConfig();
  if (cfg.dirs) {
    const images = [];
    for (const d of cfg.dirs) {
      try { if (statSync(d).isDirectory()) collectImages(d, cfg.recursive, images); } catch { /* ignore */ }
    }
    return { dirs: cfg.dirs, images };
  }

  const candidates = [
    { dir: join(WORKSPACE, '美图库'), recursive: true },
    { dir: join(WORKSPACE, '美图'), recursive: true },
    { dir: join(WORKSPACE, 'imgwork'), recursive: true },
    { dir: join(DATA_ROOT, '美图库'), recursive: true },
    { dir: join(DATA_ROOT, '表情包', 'lib', 'candidate'), recursive: false },
    { dir: join(DATA_ROOT, '表情包'), recursive: true },
  ];
  for (const c of candidates) {
    const images = [];
    try { if (statSync(c.dir).isDirectory()) collectImages(c.dir, c.recursive, images); } catch { continue; }
    if (images.length) return { dirs: [c.dir], images };
  }
  return { dirs: [], images: [] };
}

function getLibrary(force = false) {
  const now = Date.now();
  if (!force && cached.at && now - cached.at < SCAN_TTL_MS) return cached;
  cached = { at: now, ...scan() };
  return cached;
}

export function imageLibStats() {
  const lib = getLibrary();
  return { dirs: lib.dirs, count: lib.images.length };
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;

/** 挑一张；key 用于避免同一对话连续重复 */
export function pickRandomImage({ key = 'default', force = false } = {}) {
  const lib = getLibrary(force);
  const all = lib.images.filter((p) => IMAGE_EXT.test(p));
  if (!all.length) return { ok: false, reason: 'empty', dirs: lib.dirs, total: 0 };

  const recent = new Set(Array.isArray(history[key]) ? history[key].slice(-RECENT_PER_CHAT) : []);
  const pool = all.length > recent.size ? all.filter((p) => !recent.has(p)) : all;
  const path = pool[randomInt(pool.length)];

  const arr = Array.isArray(history[key]) ? history[key] : [];
  arr.push(path);
  history[key] = arr.slice(-MAX_HISTORY_PER_CHAT);
  saveHistory();

  return { ok: true, path, total: all.length, dirs: lib.dirs };
}

export function checkCooldown(key, ms = 2000) {
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev < ms) return false;
  lastSent.set(key, now);
  return true;
}

export function relPath(p) {
  try { return p.startsWith(WORKSPACE) ? p.slice(WORKSPACE.length + 1) : p; } catch { return p; }
}
