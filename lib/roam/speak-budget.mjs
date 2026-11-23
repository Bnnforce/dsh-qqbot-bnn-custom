/**
 * roam/speak-budget — 全局主动发言预算（R5.7 工业化 2026-11-23）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（真实数据）
 *
 *   这个生态里有 **5 个功能会主动说话**：
 *     · R5.7 主动逛       每天 2 次
 *     · R5.6 唤醒抽奖     每天 7 次/群
 *     · life-stream      每天 1-3 次（插件内部，自带配额）
 *     · r4-heartbeat     按静默时长
 *     · birthday-auto    生日当天
 *
 *   实测 TEST 群一天：**机器人 22 条 / 群友 19 条** —— 她比人说得还多。
 *   每个功能只看自己的限流，**没有全局视角** ⇒ 加起来就刷屏。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 怎么做
 *
 *   所有「主动开口」的功能，说话前先向本模块**申请预算**：
 *     · 全局最小间隔（默认 2 小时）—— 两次主动发言之间至少隔这么久
 *     · 全局日上限（默认 8 次）—— 一个群一天最多被主动打扰 8 次
 *     · 每个功能自己的配额外**还要**过全局这道闸
 *
 *   ⚠️ 关键设计：**先到先得**。谁先申请谁先说，其他排队/放弃。
 *      这样不需要协调 5 个功能的调度器，只在出口处收口。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么放 globalThis
 *
 *   本包是多进程/多实例共享的（不同钩子可能在不同 ctx），
 *   用 `Symbol.for` 挂全局，保证**同一进程内所有调用方看到同一份预算**。
 *   （和 zz-central-scheduler 的引擎单例同款做法。）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stateDir, nowMs } from './config.mjs';
import { diag } from './store.mjs';

/** 全局单例 key（跨模块共享）。 */
const BUDGET_KEY = Symbol.for('qqbot.speak-budget.v1');

/** 预算默认值。 */
export const BUDGET_DEFAULTS = Object.freeze({
  /** 全局最小间隔：两次主动发言之间至少隔多久（默认 2 小时）。 */
  globalMinGapMs: 2 * 3600 * 1000,
  /** 全局日上限：一个群一天最多被主动打扰几次（默认 8 次）。 */
  globalDailyCap: 8,
});

/** 每个功能在日志里的标签（便于排查「是谁说的话」）。 */
export const FEATURES = Object.freeze({
  ROAM: 'roam',           // R5.7 主动逛
  LOTTERY: 'lottery',     // R5.6 唤醒抽奖
  HEARTBEAT: 'heartbeat', // r4 心跳
  BIRTHDAY: 'birthday',   // 生日
});

/** 取（或创建）全局单例。 */
function budget() {
  let b = globalThis[BUDGET_KEY];
  if (!b) {
    /** gid → { date, today, lastAt, lastFeature } */
    b = new Map();
    globalThis[BUDGET_KEY] = b;
  }
  return b;
}

/** 状态文件（持久化，重启后不重置）。 */
function budgetFile() {
  return join(stateDir(), 'speak-budget.json');
}

/** 从磁盘读回（进程重启后恢复当日计数）。 */
export function loadBudget() {
  try {
    const f = budgetFile();
    if (!existsSync(f)) return;
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    const b = budget();
    for (const [gid, rec] of Object.entries(raw)) {
      if (rec && typeof rec === 'object') {
        b.set(gid, {
          date: typeof rec.date === 'string' ? rec.date : '',
          today: Number.isFinite(rec.today) ? rec.today : 0,
          lastAt: Number.isFinite(rec.lastAt) ? rec.lastAt : 0,
          lastFeature: typeof rec.lastFeature === 'string' ? rec.lastFeature : '',
        });
      }
    }
  } catch { /* 坏文件当空，绝不抛 */ }
}

/** 写回磁盘（原子 + 失败静默）。 */
function saveBudget() {
  try {
    const f = budgetFile();
    mkdirSync(dirname(f), { recursive: true });
    const obj = {};
    for (const [gid, rec] of budget()) obj[gid] = rec;
    const tmp = f + '.' + process.pid + '.' + Math.random().toString(16).slice(2, 8) + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, f);   // 同目录原子替换
  } catch { /* 写不进去不影响内存态 */ }
}

/** 今天（按 her 时区）。 */
function todayOf(ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  } catch {
    return '1970-01-01';
  }
}

/**
 * 申请一次主动发言预算。
 *
 * @param {string} gid 群号
 * @param {string} feature 功能标签（FEATURES.*）
 * @param {object} [cfg] 可覆盖 { globalMinGapMs, globalDailyCap }
 * @returns {{ allowed:boolean, reason:string, remainToday?:number, nextAt?:number }}
 *   reason: 'ok' | 'gap' | 'daily-cap'
 */
export function acquire(gid, feature, cfg) {
  const key = String(gid ?? '').trim();
  if (!key) return { allowed: false, reason: 'no-gid' };

  const gapMs = Number.isFinite(cfg?.globalMinGapMs) ? cfg.globalMinGapMs : BUDGET_DEFAULTS.globalMinGapMs;
  const dailyCap = Number.isFinite(cfg?.globalDailyCap) ? cfg.globalDailyCap : BUDGET_DEFAULTS.globalDailyCap;

  const now = nowMs();
  const today = todayOf(now);
  const b = budget();
  const rec = b.get(key) || { date: '', today: 0, lastAt: 0, lastFeature: '' };

  // 跨日重置
  if (rec.date !== today) {
    rec.date = today;
    rec.today = 0;
  }

  // ① 全局最小间隔
  if (rec.lastAt > 0 && now - rec.lastAt < gapMs) {
    return {
      allowed: false,
      reason: 'gap',
      remainToday: Math.max(0, dailyCap - rec.today),
      nextAt: rec.lastAt + gapMs,
    };
  }

  // ② 全局日上限
  if (rec.today >= dailyCap) {
    return { allowed: false, reason: 'daily-cap', remainToday: 0 };
  }

  return { allowed: true, reason: 'ok', remainToday: Math.max(0, dailyCap - rec.today - 1) };
}

/**
 * 记一次已经发生的主动发言（acquire 成功后调用）。
 *
 * @param {string} gid
 * @param {string} feature
 * @returns {boolean}
 */
export function commit(gid, feature) {
  const key = String(gid ?? '').trim();
  if (!key) return false;

  const now = nowMs();
  const today = todayOf(now);
  const b = budget();
  const rec = b.get(key) || { date: '', today: 0, lastAt: 0, lastFeature: '' };

  if (rec.date !== today) { rec.date = today; rec.today = 0; }
  rec.today += 1;
  rec.lastAt = now;
  rec.lastFeature = String(feature ?? '');

  b.set(key, rec);
  saveBudget();

  diag('[发言预算] ' + key.slice(0, 12) + ' ' + String(feature) + ' 今日第 ' + rec.today + ' 次');
  return true;
}

/**
 * 一步到位：申请 + 记录（常用路径）。
 *
 * @param {string} gid
 * @param {string} feature
 * @param {object} [cfg]
 * @returns {boolean} true = 可以说；false = 该让路
 */
export function trySpeak(gid, feature, cfg) {
  const r = acquire(gid, feature, cfg);
  if (!r.allowed) {
    if (r.reason !== 'gap') {
      diag('[发言预算] ' + String(gid).slice(0, 12) + ' ' + String(feature) + ' 被拒 reason=' + r.reason);
    }
    return false;
  }
  commit(gid, feature);
  return true;
}

/** 查某群当前预算状态（诊断用）。 */
export function status(gid, cfg) {
  const key = String(gid ?? '').trim();
  const gapMs = Number.isFinite(cfg?.globalMinGapMs) ? cfg.globalMinGapMs : BUDGET_DEFAULTS.globalMinGapMs;
  const dailyCap = Number.isFinite(cfg?.globalDailyCap) ? cfg.globalDailyCap : BUDGET_DEFAULTS.globalDailyCap;

  const now = nowMs();
  const today = todayOf(now);
  const rec = budget().get(key);

  if (!rec || rec.date !== today) {
    return { today: 0, cap: dailyCap, gapMs, nextAt: 0, lastFeature: '' };
  }
  return {
    today: rec.today,
    cap: dailyCap,
    gapMs,
    nextAt: rec.lastAt + gapMs,
    lastFeature: rec.lastFeature,
  };
}

/** 测试用：清空内存态。 */
export function resetForTest() {
  globalThis[BUDGET_KEY] = new Map();
}

export default {
  BUDGET_DEFAULTS,
  FEATURES,
  loadBudget,
  acquire,
  commit,
  trySpeak,
  status,
  resetForTest,
};
