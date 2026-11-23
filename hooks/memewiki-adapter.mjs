/**
 * memewiki-adapter — dsh-memewiki 在 QQBot 场景的适配层（2026-11-22）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它解决什么问题
 *
 *   `dsh-memewiki` 是通用 DSH 插件：6792 条梗库 + `search_meme_wiki` 工具 +
 *   systemPrompt 预查注入。它在 QQBot 里**基本能直接用**，但有三个群聊特有的问题：
 *
 *     ① **查梗会刷屏**：模型一次回合可能连查 3-5 个词，每个都吐一大段词条
 *     ② **反馈无门禁**：`feedback_meme_wiki` 会往 cnmeme.wiki **公开发帖**，
 *        群里任何人引导一下就能让她发出去 —— 必须只给主人
 *     ③ **查不到时容易硬编**：插件的提示是通用版，群聊里需要更强的「说不知道」
 *
 *   本 hook 只做执行层门禁（`tools.guard`），**不改插件源码**：
 *     · 每回合限流：同会话同回合最多查 N 次（默认 3）
 *     · 每分钟限流：同会话每分钟最多 M 次（默认 6，防连击）
 *     · 反馈门禁：`feedback_meme_wiki` 只允许主人
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 官方契约依据（dsh-tools/lib/index.js:649）
 *
 *   `tools.guard(fn)` —— fn 接收**单个 exec 对象**，返回：
 *     · `undefined`      → 放行
 *     · `字符串`          → 拒绝，字符串是给模型的理由
 *     · `{ reason }`      → 拒绝（结构化）
 *
 *   exec 结构（从 zz-tool-security-guard.mjs 的实现确认，不是猜）：
 *     exec.name        工具名
 *     exec.agent       当前 agent
 *     exec.arguments   工具入参
 *
 *   ⚠️ 不是 `fn(name, args)` —— 初版按这个写是错的。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么不改插件
 *   · 插件是 npm 依赖，改了下一次 `pnpm install` 就没了（本项目踩过多次）
 *   · `tools.guard()` 是官方给的执行层钩子，优先级高于工具自身
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 测试：`node Bot/维护/04-测试/mock-memewiki-adapter.mjs`
 * 配置（{EXT_DATA}/memewiki-adapter.json，改完 ≤30 秒生效）
 *   {
 *     "enabled": true,
 *     "maxCallsPerTurn": 3,
 *     "maxCallsPerMinute": 6,
 *     "feedbackOwnerOnly": true,
 *     "logDenied": true
 *   }
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA_ROOT } from '../lib/pack-paths.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';

export const name = 'memewiki-adapter';

/** 被适配的工具名（插件注册的原始名字）。 */
const SEARCH_TOOL = 'search_meme_wiki';
const FEEDBACK_TOOL = 'feedback_meme_wiki';

/** 配置文件与审计日志。 */
const CONFIG_FILE = join(DATA_ROOT, '.qqbot-extensions', 'data', 'memewiki-adapter.json');
const LOG_FILE = join(DATA_ROOT, '.qqbot-extensions', 'data', 'memewiki-adapter.log');

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  maxCallsPerTurn: 3,
  maxCallsPerMinute: 6,
  feedbackOwnerOnly: true,
  logDenied: true,
});

/* ──────────────────────────────────────────────────────────────
 * 配置（30 秒缓存，坏文件当默认，绝不抛）
 * ────────────────────────────────────────────────────────────── */

let cfgCache = null;
let cfgAt = 0;

function readConfig() {
  const now = Date.now();
  if (cfgCache && now - cfgAt < 30000) return cfgCache;

  let cfg = { ...DEFAULT_CONFIG };
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        cfg = {
          enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.enabled,
          maxCallsPerTurn: Number.isFinite(Number(raw.maxCallsPerTurn))
            ? Math.max(1, Math.round(Number(raw.maxCallsPerTurn))) : DEFAULT_CONFIG.maxCallsPerTurn,
          maxCallsPerMinute: Number.isFinite(Number(raw.maxCallsPerMinute))
            ? Math.max(1, Math.round(Number(raw.maxCallsPerMinute))) : DEFAULT_CONFIG.maxCallsPerMinute,
          feedbackOwnerOnly: typeof raw.feedbackOwnerOnly === 'boolean'
            ? raw.feedbackOwnerOnly : DEFAULT_CONFIG.feedbackOwnerOnly,
          logDenied: typeof raw.logDenied === 'boolean' ? raw.logDenied : DEFAULT_CONFIG.logDenied,
        };
      }
    }
  } catch { /* 坏配置当默认 */ }

  cfgCache = cfg;
  cfgAt = now;
  return cfg;
}

/** 审计日志（失败静默）。 */
function note(line) {
  if (!readConfig().logDenied) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* ignore */ }
}

/* ──────────────────────────────────────────────────────────────
 * 限流计数（内存态）
 * ────────────────────────────────────────────────────────────── */

/** sessionId|turnKey → 次数 */
const turnCounts = new Map();
/** sessionId|minuteKey → 次数 */
const minuteCounts = new Map();
let lastSweep = 0;

/** 每 5 分钟清过期键，防内存涨。 */
function sweepIfNeeded() {
  const now = Date.now();
  if (now - lastSweep < 5 * 60 * 1000) return;
  lastSweep = now;

  const minuteNow = Math.floor(now / 60000);
  for (const key of [...minuteCounts.keys()]) {
    const m = Number(key.split('|')[1]);
    if (!Number.isFinite(m) || minuteNow - m > 5) minuteCounts.delete(key);
  }
  if (turnCounts.size > 2000) turnCounts.clear();
}

function sessionKeyOf(exec) {
  try {
    return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '') || 'unknown';
  } catch { return 'unknown'; }
}

/**
 * 回合标识：用 session 事件条数。
 *
 * 同一回合里事件数基本不变（工具调用不额外产生 user/message），
 * 换一轮就 +1 —— 足够区分回合边界，且零 IO。
 */
function turnKeyOf(exec) {
  try {
    const s = exec?.agent?.session;
    if (s && typeof s.snapshotEvents === 'function') {
      return String((s.snapshotEvents() || []).length);
    }
  } catch { /* ignore */ }
  return '0';
}

/** 当前消息的发送者是否主人（复用 zz-tool-security-guard 同一套符号表）。 */
function isOwnerNow(exec) {
  try {
    const map = globalThis[Symbol.for('qqbot.current-sender')];
    if (!(map instanceof Map)) return false;
    const agent = exec?.agent;
    const ch = agent?.ctx?.get?.('qqChannel');
    const mgr = ch?.manager;
    const sid = String(agent?.session?.id ?? '');
    const rec = (sid && mgr?.findBySessionId?.(sid)) || mgr?.findByAgent?.(agent);
    if (!rec) return false;

    const key = `${String(rec.scope ?? '')}:${String(rec.peerId ?? '')}`;
    const e = map.get(key);
    if (!e) return false;
    if (e.isOwner === true) return true;

    const owners = Array.isArray(mgr?.adminOwners?.()) ? mgr.adminOwners() : [];
    return Boolean(e.senderId && owners.includes(String(e.senderId)));
  } catch { return false; }
}

/* ──────────────────────────────────────────────────────────────
 * 守卫主体（签名严格对齐官方 exec 对象）
 * ────────────────────────────────────────────────────────────── */

/**
 * tools.guard 的守卫函数。
 *
 * @param {{name:string, agent:object, arguments:object}} exec
 * @returns {string|undefined} 字符串 = 拒绝并作为理由回给模型；undefined = 放行
 */
function guard(exec) {
  try {
    const toolName = String(exec?.name ?? '');
    if (toolName !== SEARCH_TOOL && toolName !== FEEDBACK_TOOL) return undefined;

    const cfg = readConfig();
    if (!cfg.enabled) return undefined;

    // ── 反馈：只给主人 ──
    if (toolName === FEEDBACK_TOOL) {
      if (!cfg.feedbackOwnerOnly) return undefined;
      if (isOwnerNow(exec)) return undefined;

      note(`DENY ${FEEDBACK_TOOL} 非主人`);
      return '这个反馈会公开投到梗维基（cnmeme.wiki），只有主人能决定要不要发。'
        + '你可以先接住对方说的，然后告诉他「这个我得问问主人」。';
    }

    // ── 查梗：限流 ──
    sweepIfNeeded();
    const sid = sessionKeyOf(exec);
    const tKey = `${sid}|${turnKeyOf(exec)}`;
    const mKey = `${sid}|${Math.floor(Date.now() / 60000)}`;

    const turnCount = (turnCounts.get(tKey) || 0) + 1;
    const minuteCount = (minuteCounts.get(mKey) || 0) + 1;

    if (turnCount > cfg.maxCallsPerTurn) {
      note(`DENY ${SEARCH_TOOL} turn=${turnCount}>${cfg.maxCallsPerTurn} sid=${sid.slice(0, 8)}`);
      return `这一轮已经查了 ${cfg.maxCallsPerTurn} 次梗了，够了。`
        + '直接用查到的接话，别再查。还有没把握的词就说自己没听过。';
    }
    if (minuteCount > cfg.maxCallsPerMinute) {
      note(`DENY ${SEARCH_TOOL} minute=${minuteCount}>${cfg.maxCallsPerMinute} sid=${sid.slice(0, 8)}`);
      return '查得太密了，缓一缓。没把握的词就说不知道，别硬猜。';
    }

    // 放行也要记账（上面已经 +1）
    turnCounts.set(tKey, turnCount);
    minuteCounts.set(mKey, minuteCount);
    return undefined;
  } catch {
    // 守卫自身出错一律放行 —— 不能因为适配层 bug 让查梗彻底不可用
    return undefined;
  }
}

/* ──────────────────────────────────────────────────────────────
 * 生命周期：给每个 QQ agent 装守卫
 * ────────────────────────────────────────────────────────────── */

const seen = new WeakSet();
const disposers = [];

/** 从 env 取所有 agent。 */
function agentsOf(env) {
  const out = [];
  try {
    const ch = env?.ctx?.get?.('qqChannel') ?? env?.caps?.kernel?.get?.('qqChannel');
    const mgr = ch?.manager;
    if (!mgr) return out;

    // 常见形态：manager.sessions / manager.list() / manager.all()
    const candidate = mgr.sessions;
    if (candidate && typeof candidate.values === 'function') {
      for (const rec of candidate.values()) if (rec?.agent) out.push(rec.agent);
    } else if (candidate && typeof candidate === 'object') {
      for (const rec of Object.values(candidate)) if (rec?.agent) out.push(rec.agent);
    }

    for (const fn of ['list', 'all', 'records', 'agents']) {
      if (typeof mgr[fn] === 'function') {
        const list = mgr[fn]();
        if (Array.isArray(list)) {
          for (const rec of list) if (rec?.agent) out.push(rec.agent);
          break;
        }
      }
    }
  } catch { /* ignore */ }
  return out;
}

/** 扫一遍 agent 并装守卫。 */
function sweepAgents(env, logger) {
  if (!readConfig().enabled) return 0;

  let installed = 0;
  for (const agent of agentsOf(env)) {
    if (!agent || seen.has(agent)) continue;
    try {
      const tools = agent?.ctx?.tools ?? agent?.ctx?.get?.('tools');
      if (!tools || typeof tools.guard !== 'function') continue;
      const dispose = tools.guard(guard);
      if (typeof dispose === 'function') disposers.push(dispose);
      seen.add(agent);
      installed += 1;
    } catch (e) {
      logger?.warn?.(`[memewiki-adapter] 装守卫失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return installed;
}

export async function run(env) {
  const logger = env?.logger ?? console;
  const cfg = readConfig();

  if (!cfg.enabled) {
    logger?.info?.('[memewiki-adapter] 已禁用（配置 enabled:false）');
    return;
  }

  const first = sweepAgents(env, logger);
  logger?.info?.(`[memewiki-adapter] 启动：已给 ${first} 个 agent 装上门禁`);

  // 30 秒轮询补装（新会话/新群陆续建立）
  registerWithFallback('memewiki-adapter', () => sweepAgents(env, logger), {
    env,
    fallbackMs: 30000,
    label: 'memewiki-adapter',
    meta: { id: 'ext-memewiki-adapter' },
  });
}

export function dispose() {
  for (const d of disposers) {
    try { if (typeof d === 'function') d(); } catch { /* ignore */ }
  }
  disposers.length = 0;
  turnCounts.clear();
  minuteCounts.clear();
}

/** 测试出口：导出内部函数便于单测（生产不依赖这些）。 */
export const __test = { readConfig, guard, sessionKeyOf, turnKeyOf, isOwnerNow, sweepIfNeeded };

export default { name, run, dispose };
