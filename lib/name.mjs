/**
 * 当前人格称呼判定。
 * 名字来源：当前群人格状态 + 人格/角色卡/<name>.md + 人格/persona-aliases.json
 *          + QQ 机器人账号昵称（{dataRoot}/.qqbot/bot-self.json）。
 * 人格名与账号昵称任一命中都算被叫；其他角色卡按文件名和 alias 文件判定。
 *
 * 2026-11-01 性能修复（审查 P2-3）：这条链路原先**每条群消息被调用 3 次**，每次都
 * `readConfig()` + `defaultPersona()`（readdir 角色卡 + 逐张读+校验）+ `loadState()` +
 * `readAliases()` ≈ 5 次文件读 + 1 次目录扫描（实测 cold 17ms / warm 4ms，整条 inbound 链
 * 13.4ms/条）。现在改成**进程级缓存 + 文件指纹失效**：
 *   · 指纹 = persona-config.json / persona-aliases.json / persona-groups.json /
 *     角色卡目录 的 (mtimeMs,size)；任一变化立即重载，所以改人格/切人格不会读到旧值；
 *   · 每群解析结果在同一代缓存内复用；
 *   · `calledByCurrentText` 再按 (ctx,text) 做一次 memo（同一消息被 3 个模块调用时只算一次）。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONA_ROOT, CONFIG_FILE, readConfig, listPersonaChoices, defaultPersona } from './io/persona-store.mjs';
import { STATE_FILE, loadState, groupState } from './io/persona-switch.mjs';
import { DATA_ROOT } from './pack-paths.mjs';

export const NAME_VERSION = '20261029-persona';
const ALIAS_FILE = join(PERSONA_ROOT, 'persona-aliases.json');
const SHORT_AN_RE = /(?:^|[^\u4e00-\u9fa5])安安(?!稳|心|静|分|乐|逸|闲)/u;

/** 取一个文件的 (mtimeMs,size) 指纹；不存在返回 '-'。 */
function fileFingerprint(file) {
  try {
    const st = statSync(file, { throwIfNoEntry: false });
    return st ? `${st.mtimeMs}:${st.size}` : '-';
  } catch { return '-'; }
}

/** 当前一代缓存：{ cfg, def, aliases, state, personaByGid, sig } */
let cache = null;

function readAliases() {
  try {
    const j = JSON.parse(readFileSync(ALIAS_FILE, 'utf8')) || {};
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

/** 重新校验文件指纹的最小间隔：/sdcard 是 FUSE，一次 stat≈0.5–1ms，4 个文件每次调用都 stat 反而更慢。
 *  3s 内的窗口用内存缓存（人格切换/改配置最多晚 3s 生效，下一条消息就能纠正）。 */
const REVALIDATE_MS = 3000;
function fingerprint() {
  const cardsDir = cache?.cfg?.personasDir || '';
  return [
    fileFingerprint(CONFIG_FILE),
    fileFingerprint(ALIAS_FILE),
    fileFingerprint(STATE_FILE),
    cardsDir ? fileFingerprint(cardsDir) : '-',
  ].join('|');
}

function loadCache() {
  const now = Date.now();
  if (cache && now - cache.checkedAt < REVALIDATE_MS) return cache;
  const sigNow = fingerprint();
  if (cache && cache.sig === sigNow) { cache.checkedAt = now; return cache; }
  const cfg = readConfig();
  let def = null;
  let choices = [];
  try { choices = listPersonaChoices(cfg); def = defaultPersona(cfg); } catch { def = null; choices = []; }
  let state = { version: 1, groups: {} };
  try { state = loadState(); } catch { /* 状态文件坏了就按空处理 */ }
  cache = {
    cfg,
    def,
    choices,
    aliases: readAliases(),
    state,
    personaByGid: new Map(),
    checkedAt: now,
    sig: '', // 先占位，拿到 cfg.personasDir 后再算一次
  };
  cache.sig = fingerprint();
  return cache;
}

/** 人格/状态/配置变化后需要立即生效时调用（正常情况靠文件指纹自动失效）。 */
export function invalidateNameCache() {
  cache = null;
}

function groupIdOf(ctx) {
  return String(ctx?.message?.groupOpenid ?? ctx?.peer?.peerId ?? ctx?.replyTarget?.targetId ?? '');
}

/** 与 persona-store.normalizePersonaName 同语义，但用本代缓存的 choices/default，避免每次重扫目录。 */
function normalizePersonaNameCached(raw, c) {
  const name = String(raw || '').trim().replace(/\.md$/i, '');
  if (name === '1' || !name) return c.def?.name || '';
  if (name === '2') return (c.choices.find((p) => p.name !== c.def?.name) || c.def)?.name || '';
  if (c.choices.some((p) => p.name === name)) return name;
  return c.def?.name || '';
}

function personaForGroup(gid) {
  const c = loadCache();
  if (!c.def) return '';
  if (gid && c.personaByGid.has(gid)) return c.personaByGid.get(gid);
  let selected = c.def.name;
  try {
    if (gid) selected = normalizePersonaNameCached(groupState(c.state, gid).persona, c) || c.def.name;
  } catch { selected = c.def.name; }
  if (gid) c.personaByGid.set(gid, selected);
  return selected;
}

export function aliasesForPersona(name) {
  const n = String(name || '').trim();
  const c = loadCache();
  const custom = Array.isArray(c.aliases[n]) ? c.aliases[n].map(String).filter(Boolean) : [];
  const out = [...new Set([n, ...custom].filter(Boolean))];
  out.sort((a, b) => b.length - a.length);
  return out;
}

export function matchesPersonaName(text, aliases, defaultPersonaName = '爱莉希雅') {
  const t = String(text ?? '');
  for (const alias of aliases || []) {
    // 「安安」这种短别名只对「比安安」这个词做词界处理（避免命中"平平安安/安安稳稳"）；
    // 其他人格的别名一律直接 includes。
    if (alias === '安安' && defaultPersonaName === '比安安') {
      if (SHORT_AN_RE.test(t)) return true;
    } else if (t.includes(alias)) return true;
  }
  return false;
}

/** 同一 ctx 同一正文只算一次（inbound 链里 aac / trigger / current-sender 各调一次）。 */
const memo = new WeakMap();

/** 当前消息正文（剔除被引用原文后）是否叫了当前人格名 */
export function calledByCurrentText(ctx) {
  const text = String(ctx?.text ?? '');
  const memoized = ctx && typeof ctx === 'object' ? memo.get(ctx) : undefined;
  if (memoized && memoized.text === text) return memoized.result;
  const qt = String(ctx?.state?.quote?.text ?? '');
  const current = qt ? text.replace(qt, '') : text;
  const gid = groupIdOf(ctx);
  const persona = personaForGroup(gid);
  // 2026-11-02：没有人格状态时兜底用「默认人格名」，不再写死比安安
  let fallback = '爱莉希雅';
  try { fallback = defaultPersona()?.name || fallback; } catch { /* 读不到就用常量 */ }
  const result = persona
    ? matchesPersonaName(current, aliasesForPersona(persona), persona)
    : matchesPersonaName(current, [fallback], fallback);
  try { if (ctx && typeof ctx === 'object') memo.set(ctx, { text, result }); } catch { /* ignore */ }
  return result || calledByAccountName(current);
}

/**
 * 兜底：按**机器人自己的 QQ 昵称**判断（2026-11-02）。
 *
 * 起因：默认人格与机器人账号昵称是两套东西 —— 群里的人经常直接叫**头像/昵称**上的名字，
 *   而不是当前人格名；只按人格名判就**叫不醒**（实测 false）。
 * 做法：额外读 `{dataRoot}/.qqbot/bot-self.json` 的 username（插件自己写的 QQ 资料缓存），
 *   命中即视为叫了机器人。人格名与账号名任一命中都算被叫。
 * 注意：只影响「叫名字」这一条唤醒路径；正文里用哪个人格说话仍由当前人格卡决定。
 */
const BOT_SELF_FILE = join(DATA_ROOT, '.qqbot', 'bot-self.json');

function calledByAccountName(text) {
  const t = String(text ?? '');
  if (!t) return false;
  let username = '';
  try {
    const st = statSync(BOT_SELF_FILE, { throwIfNoEntry: false });
    const now = Date.now();
    if (!accountNameCache || accountNameCache.mtime !== st?.mtimeMs) {
      const j = JSON.parse(readFileSync(BOT_SELF_FILE, 'utf8')) || {};
      username = String(j.username || '').trim();
      accountNameCache = { username, mtime: st?.mtimeMs ?? 0, at: now };
    } else return accountNameCache.username ? t.includes(accountNameCache.username) : false;
  } catch { return false; }
  return username ? t.includes(username) : false;
}

let accountNameCache = null;

export function addressed(ctx) {
  return ctx?.platform?.mentioned === true || calledByCurrentText(ctx);
}
