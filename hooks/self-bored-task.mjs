/**
 * self-bored-task — 无聊时自主创造（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人要的三种触发方式，这是第一种：
 *
 *   | 触发 | 次数限制 | 为什么 |
 *   |---|---|---|
 *   | 定时（每天一次） | 不设 | 已经在跑 |
 *   | **无聊（这个）** | **要限制** | 防刷屏、防半夜作妖 |
 *   | 主动想起 | 不设 | 那是灵感，不该拦 |
 *   | 群友提议 | 走评估 | 要看可行性和风险 |
 *
 * ── 怎么判断「无聊」────────────────────────────────────────────────────────
 *
 *   四层，全部要满足（抄的是 roam-scheduler 实战打磨过的模式）：
 *
 *     ① 不在睡眠窗口（深夜不吵人）
 *     ② 今天的「无聊造物」次数 < cap（默认 2 次）
 *     ③ 距上次 ≥ 4 小时
 *     ④ **群聊真的安静** ≥ 2 小时（有人在聊就别插进去造物）
 *
 *   还有一条：今天如果已经「定时造物」过了，就不再来一遍。
 *
 * ── 为什么用 wakeTo 而不是自己干 ───────────────────────────────────────────
 *
 *   hook 拿不到 LLM（env 只有 dataRoot/wakeTo，实测无 kernel）。
 *   所以只能 `caps.wakeTo('group', gid, prompt)` 把她叫起来，
 *   她自己决定要不要动、动什么。
 *
 *   ⚠️ 已知坑（roam 那边踩过）：会话闲置会被回收 → wakeTo 返回 false。
 *      已在 profile 配了 sessionIdleTimeout: 4h 缓解。
 *      这里遇到 false 就记日志，本轮静默，不重试。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { appendLogRotating } from '../lib/log-rotate.mjs';

const name = 'self-bored-task';
const FALLBACK_MS = 3600_000;            // 每小时 tick 一次

const DSH_HOME = process.env.DSH_HOME
  || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';

function stateFile() { return join(EXT_DATA, 'self-bored-state.json'); }
function diagFile() { return join(EXT_DATA, 'self-bored.log'); }
function createStateFile() { return join(EXT_DATA, 'self-create-state.json'); }

function diag(event, extra = {}) {
  try {
    appendLogRotating(diagFile(), `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`, 256 * 1024);
  } catch { /* ignore */ }
}

/** 默认配置（都可被 self-bored-config.json 覆盖）。 */
const DEFAULT_CFG = Object.freeze({
  enabled: true,                 // 总开关
  dailyCap: 2,                   // 每天最多几次无聊造物
  minGapMs: 4 * 3600_000,        // 两次之间至少隔 4 小时
  idleNeedMs: 2 * 3600_000,      // 群要安静至少 2 小时
  sleepStart: 1,                 // 1:00
  sleepEnd: 7,                   // 7:00
  timezone: 'Asia/Shanghai',
  maxGroupsPerTick: 1,           // 一次 tick 最多唤醒 1 个群
});

function readCfg() {
  try {
    const f = join(EXT_DATA, 'self-bored-config.json');
    if (!existsSync(f)) return { ...DEFAULT_CFG };
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    return { ...DEFAULT_CFG, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

function readState() {
  try {
    if (!existsSync(stateFile())) return {};
    return JSON.parse(readFileSync(stateFile(), 'utf8')) || {};
  } catch { return {}; }
}

function writeState(obj) {
  try {
    mkdirSync(EXT_DATA, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** 当前小时（按时区）。 */
function hourOf(nowMs, tz) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date(nowMs)));
  } catch {
    return new Date(nowMs).getHours();
  }
}

function dateKeyOf(nowMs, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  } catch {
    const d = new Date(nowMs);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

function inSleepWindow(hour, start, end) {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;   // 跨午夜
}

/**
 * 群聊最后一条消息的时间（用来判断「真的安静」）。
 *
 * @param {string} gid
 * @param {number} nowMs
 * @returns {number} 最后活动时间戳（拿不到返回 0）
 */
function lastActivityAt(gid, nowMs) {
  try {
    const dir = join(EXT_DATA, 'msg-archive', gid);
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    if (!files.length) return 0;
    // 从最新文件倒着找最后一条
    for (let i = files.length - 1; i >= 0; i--) {
      const lines = readFileSync(join(dir, files[i]), 'utf8').split('\n').filter(Boolean);
      for (let j = lines.length - 1; j >= 0; j--) {
        try {
          const o = JSON.parse(lines[j]);
          if (Number.isFinite(o.t)) return Number(o.t);
        } catch { /* skip */ }
      }
    }
    return 0;
  } catch { return 0; }
}

/** 今天定时造物跑过没（避免连续两轮）。 */
function createdToday(dateKey) {
  try {
    if (!existsSync(createStateFile())) return false;
    const s = JSON.parse(readFileSync(createStateFile(), 'utf8'));
    return s?.lastDay === dateKey;
  } catch { return false; }
}

/**
 * 判断某个群现在该不该「无聊造物」。
 *
 * @returns {{yes:boolean, reason:string}}
 */
function shouldBored(gid, state, cfg, nowMs) {
  if (cfg.enabled !== true) return { yes: false, reason: 'disabled' };

  const hour = hourOf(nowMs, cfg.timezone);
  if (inSleepWindow(hour, cfg.sleepStart, cfg.sleepEnd)) return { yes: false, reason: 'sleep-window' };

  const today = dateKeyOf(nowMs, cfg.timezone);
  const cap = Number.isFinite(cfg.dailyCap) ? cfg.dailyCap : 2;
  const used = state.date === today && Number.isFinite(state.count) ? state.count : 0;
  if (used >= cap) return { yes: false, reason: 'daily-cap' };

  const gap = Number.isFinite(cfg.minGapMs) ? cfg.minGapMs : 4 * 3600_000;
  const last = Number.isFinite(state.lastAt) ? state.lastAt : 0;
  if (last > 0 && nowMs - last < gap) return { yes: false, reason: 'interval' };

  // 群要真的安静
  const idleNeed = Number.isFinite(cfg.idleNeedMs) ? cfg.idleNeedMs : 2 * 3600_000;
  const la = lastActivityAt(gid, nowMs);
  if (la > 0 && nowMs - la < idleNeed) return { yes: false, reason: 'group-active' };

  // 今天定时造物已经跑过 → 不再重复
  if (createdToday(today)) return { yes: false, reason: 'already-created-today' };

  return { yes: true, reason: 'ready' };
}

/** 组装给她的提示（关键：允许她拒绝）。 */
function buildPrompt(gid, cfg) {
  return [
    '【无聊时刻】',
    '',
    '群里安静两个多小时了，你自己待着。',
    '',
    '现在是你自己的时间。可以：',
    '· 想想有什么一直没做的事',
    '· 翻翻待办，挑一件推一下',
    '· 或者就是发个呆，什么都不干',
    '',
    '**不想动就直说「算了，我歇会儿」，没人催你。**',
    '',
    '想动手的话，先看 Bot/自我/我的造物手册.md，七步走。',
    '你能读写文件、跑命令、记目标。改完自己验证。',
    '',
    `（这是今天第 ${(readState().count || 0) + 1} 次无聊时被叫起来，一天最多 ${cfg.dailyCap} 次）`,
  ].join('\n');
}

/**
 * 主流程。
 */
async function tick(env) {
  const caps = env?.caps ?? env ?? {};
  const cfg = readCfg();
  const state = readState();
  const nowMs = Date.now();
  const today = dateKeyOf(nowMs, cfg.timezone);

  // 今日状态归零
  if (state.date !== today) {
    state.date = today;
    state.count = 0;
  }

  // 找群
  let groups = [];
  try {
    const base = join(EXT_DATA, 'msg-archive');
    if (existsSync(base)) groups = readdirSync(base).filter((d) => d.startsWith('group_'));
  } catch { /* ignore */ }

  if (!groups.length) {
    diag('skip', { reason: 'no-groups' });
    return { ok: true, skipped: 'no-groups' };
  }

  const maxPerTick = Math.max(1, Number(cfg.maxGroupsPerTick) || 1);
  let woken = 0;

  for (const gid of groups) {
    if (woken >= maxPerTick) break;

    const judge = shouldBored(gid, state, cfg, nowMs);
    if (!judge.yes) {
      continue;
    }

    // 唤醒她（她自己决定做不做）
    let ret = null;
    try {
      ret = await caps.wakeTo?.('group', gid, buildPrompt(gid, cfg));
    } catch (e) {
      diag('wake-error', { gid: gid.slice(6, 14), err: String(e).slice(0, 80) });
      continue;
    }

    const ok = ret !== false;
    diag('wake', { gid: gid.slice(6, 14), ret: String(ret), ok, count: (state.count || 0) + 1 });

    if (ok) {
      // ⚠️ 只有真发出去了才计次（roam 那边踩过坑：额度被空烧）
      state.count = (state.count || 0) + 1;
      state.lastAt = nowMs;
      woken += 1;
    }
  }

  writeState(state);
  return { ok: true, woken, count: state.count || 0, cap: cfg.dailyCap };
}

/** hook 入口。 */
export async function run(env) {
  try {
    const r = await tick(env);
    diag('boot', { woken: r.woken, skipped: r.skipped });
  } catch (e) {
    diag('boot-error', { err: String(e).slice(0, 120) });
  }

  registerWithFallback('self-bored-task', () => tick(env), {
    env,
    fallbackMs: FALLBACK_MS,
    label: 'self-bored-task',
    meta: { id: 'ext-self-bored' },
  });
}

export { tick, shouldBored, readCfg, DEFAULT_CFG };
export default { name, run };
