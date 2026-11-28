/**
 * points/earn — 积分产出（2026-11-17）
 *
 * 四个来源：签到 / 抽签 / 猜拳 / 骰子
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 防刷设计（这是本模块的核心）：
 *
 *   ① 签到 —— 按日期键判重（一天一次）
 *   ② 抽签 —— 按 dateKey 判重（抽签本来就是"一天一种"）
 *   ③ 猜拳/骰子 —— **只限次数，不限分数**（主人 2026-11-17 明确）：
 *        · 每个玩法每天最多 perGameDailyCap 次（默认 5）
 *        · **每日总分不设上限** —— 你抽到大吉 +5 就是 +5，玩满 5 次就该拿满
 *        · 冷却默认关闭（playCooldownMs=0）
 *        · 超限后**照样能玩**，只是没有分（绝不阻断游戏）
 *
 * 🔴 关键原则：限制的是「得分」，不是「玩」。
 *    让玩家觉得"不让玩了"才是真正的失败。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { dateKeyOf } from '../pure/time-utils.mjs';
import { shopErr, ERR } from '../pure/errors.mjs';
import { fortunePointsOf } from './config.mjs';

/** 内存级冷却表：`${openid}:${gameId}` → 上次得分时间戳。 */
const COOLDOWN = new Map();

export function _resetCooldowns() {
  COOLDOWN.clear();
}

function cooldownOk(openid, gameId, ms, nowMs) {
  if (!(ms > 0)) return true;
  const k = `${openid}:${gameId}`;
  const last = COOLDOWN.get(k);
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (last && now - last < ms) return false;
  return true;
}

function markCooldown(openid, gameId, nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  COOLDOWN.set(`${openid}:${gameId}`, now);
}

/** 推一条 ledger 并更新余额/统计。 */
function applyDelta(store, data, delta, entry) {
  const d = Number(delta) || 0;
  data.balance = Math.max(0, (Number(data.balance) || 0) + d);
  if (d > 0) data.stats.totalEarned = (Number(data.stats.totalEarned) || 0) + d;
  else data.stats.totalSpent = (Number(data.stats.totalSpent) || 0) + (-d);
  data.stats.lastActiveAt = entry.at;
  store.pushLedger(data, { ...entry, delta: d, balance: data.balance });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// ① 签到
// ─────────────────────────────────────────────────────────────────────────

/**
 * 每日签到。
 *
 * @param {object} store
 * @param {{openid:string, name?:string, nowMs?:number}} p
 * @returns {Promise<{ok:boolean, reason?:string, points?:number, balance?:number, totalDays?:number}>}
 */
export async function doCheckin(store, p) {
  const cfg = store.cfg;
  const nowMs = p.nowMs ?? Date.now();
  const today = dateKeyOf(nowMs, cfg.timezone);
  const points = Number(cfg.checkinPoints) || 0;

  return store.update(p.openid, (data) => {
    const last = String(data.checkin?.lastDate || '');
    if (last === today) {
      throw shopErr(ERR.ALREADY_DONE, '今天已经签过了', { today });
    }
    const at = new Date(nowMs).toISOString();
    data.checkin = {
      lastDate: today,
      totalDays: (Number(data.checkin?.totalDays) || 0) + 1,
    };
    applyDelta(store, data, points, { at, type: 'checkin' });
    return data;
  }, { name: p.name, nowIso: new Date(nowMs).toISOString() })
    .then((d) => ({ ok: true, points, balance: d.balance, totalDays: d.checkin.totalDays }))
    .catch((e) => {
      if (e?.code === ERR.ALREADY_DONE) return { ok: false, reason: 'ALREADY' };
      throw e;
    });
}

// ─────────────────────────────────────────────────────────────────────────
// ② 抽签
// ─────────────────────────────────────────────────────────────────────────

/**
 * 抽签发分（按 score，一天一次）。
 *
 * @param {object} store
 * @param {{openid:string, name?:string, score:number, dateKey:string, nowMs?:number}} p
 */
export async function fromFortune(store, p) {
  const cfg = store.cfg;
  const nowMs = p.nowMs ?? Date.now();
  const dk = String(p.dateKey || dateKeyOf(nowMs, cfg.timezone));
  const score = Math.max(1, Math.min(10, Math.floor(Number(p.score) || 0)));
  const points = fortunePointsOf(cfg, score);

  return store.update(p.openid, (data) => {
    const last = String(data.fortune?.lastDateKey || '');
    if (last === dk) {
      // 同一天已经领过 → 不改数据，用一个哨兵让外层知道
      throw shopErr(ERR.ALREADY_DONE, '今天已经领过抽签分', { dk });
    }
    const at = new Date(nowMs).toISOString();
    data.fortune = { lastDateKey: dk, lastScore: score };
    applyDelta(store, data, points, { at, type: 'fortune', score });
    return data;
  }, { name: p.name, nowIso: new Date(nowMs).toISOString() })
    .then((d) => ({ ok: true, points, balance: d.balance, score }))
    .catch((e) => {
      if (e?.code === ERR.ALREADY_DONE) return { ok: false, reason: 'ALREADY', points: 0 };
      throw e;
    });
}

// ─────────────────────────────────────────────────────────────────────────
// ③ 玩法（猜拳 / 骰子）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 判断某个玩法现在还能不能得分（不写数据）。
 *
 * @param {object} store
 * @param {string} openid
 * @param {string} gameId 'rps' | 'dice'
 * @param {number} nowMs
 * @returns {Promise<{ok:boolean, reason?:string, used?:number, cap?:number}>}
 */
export async function canEarnPlay(store, openid, gameId, nowMs = Date.now()) {
  const cfg = store.cfg;
  const today = dateKeyOf(nowMs, cfg.timezone);
  const cap = Number(cfg.perGameDailyCap) || 5;

  return store.readLocked(openid, (data) => {
    if (!data) return { ok: true, used: 0, cap };
    const dp = data.dailyPlay || {};
    if (String(dp.date || '') !== today) return { ok: true, used: 0, cap };
    const used = Number(dp.byGame?.[gameId]) || 0;
    if (used >= cap) return { ok: false, reason: 'GAME_CAP', used, cap };
    if (!cooldownOk(openid, gameId, cfg.playCooldownMs, nowMs)) {
      return { ok: false, reason: 'COOLDOWN', used, cap };
    }
    return { ok: true, used, cap };
  });
}

/**
 * 玩法得分（猜拳用 delta，骰子用固定值）。
 *
 * @param {object} store
 * @param {{openid:string, name?:string, gameId:string, delta?:number, nowMs?:number}} p
 *        delta 不传时用 cfg 里的默认值（骰子 = dicePoints）
 * @returns {Promise<{ok:boolean, reason?:string, delta:number, balance:number, left:number}>}
 */
export async function fromPlay(store, p) {
  const cfg = store.cfg;
  const nowMs = p.nowMs ?? Date.now();
  const today = dateKeyOf(nowMs, cfg.timezone);
  const cap = Number(cfg.perGameDailyCap) || 5;
  const gameId = String(p.gameId || '');

  // 前置检查（快速失败，不进锁）
  const pre = await canEarnPlay(store, p.openid, gameId, nowMs);
  if (!pre.ok) {
    const cur = store.read(p.openid);
    return {
      ok: false,
      reason: pre.reason,
      delta: 0,
      balance: Number(cur?.balance) || 0,
      left: Math.max(0, cap - (pre.used || 0)),
    };
  }

  let actualDelta = 0;
  return store.update(p.openid, (data) => {
    // 跨天重置
    if (String(data.dailyPlay?.date || '') !== today) {
      data.dailyPlay = { date: today, used: 0, byGame: {} };
    }
    data.dailyPlay.byGame = data.dailyPlay.byGame || {};
    const used = Number(data.dailyPlay.byGame[gameId]) || 0;
    if (used >= cap) {
      throw shopErr(ERR.GAME_CAP, '这个玩法今天的分拿满了', { gameId, used, cap });
    }

    // 计算增量
    let delta = Number.isFinite(Number(p.delta)) ? Number(p.delta) : Number(cfg.dicePoints) || 1;
    if (delta < 0 && cfg.rpsAllowNegative !== true) {
      // 不允许负余额 → 最多扣到 0
      delta = -Math.min(Math.abs(delta), Math.max(0, Number(data.balance) || 0));
    }

    const at = new Date(nowMs).toISOString();
    data.dailyPlay.byGame[gameId] = used + 1;
    data.dailyPlay.used = (Number(data.dailyPlay.used) || 0) + 1;

    actualDelta = delta;
    applyDelta(store, data, delta, { at, type: 'play', game: gameId });
    markCooldown(p.openid, gameId, nowMs);
    return data;
  }, { name: p.name, nowIso: new Date(nowMs).toISOString() })
    .then((d) => ({
      ok: true,
      delta: actualDelta,
      balance: d.balance,
      left: Math.max(0, cap - (Number(d.dailyPlay.byGame[gameId]) || 0)),
    }))
    .catch((e) => {
      if (e?.code === ERR.GAME_CAP) return { ok: false, reason: 'GAME_CAP', delta: 0, balance: 0, left: 0 };
      throw e;
    });
}

/**
 * 猜拳结算（按结果给分/扣分）。
 *
 * @param {object} store
 * @param {{openid:string, name?:string, result:'win'|'tie'|'lose', nowMs?:number}} p
 */
export async function fromRps(store, p) {
  const cfg = store.cfg;
  const result = String(p.result || '');
  let delta = 0;
  if (result === 'win') delta = Number(cfg.rpsWinPoints) || 0;
  else if (result === 'tie') delta = Number(cfg.rpsTiePoints) || 0;
  else delta = Number(cfg.rpsLosePoints) || 0;

  const r = await fromPlay(store, {
    openid: p.openid, name: p.name, gameId: 'rps', delta, nowMs: p.nowMs,
  });
  return { ...r, result };
}

// ─────────────────────────────────────────────────────────────────────────
// ④ 查询
// ─────────────────────────────────────────────────────────────────────────

/** 读余额（不建档案）。 */
export function getBalance(store, openid) {
  const d = store.read(openid);
  return Number(d?.balance) || 0;
}

/** 今日还能在哪些玩法拿分（诊断/提示用）。 */
export async function todayStatus(store, openid, nowMs = Date.now()) {
  const cfg = store.cfg;
  const today = dateKeyOf(nowMs, cfg.timezone);
  const d = store.read(openid);
  const cap = Number(cfg.perGameDailyCap) || 5;
  const dp = d?.dailyPlay || {};
  const fresh = String(dp.date || '') !== today;
  return {
    balance: Number(d?.balance) || 0,
    signedToday: String(d?.checkin?.lastDate || '') === today,
    fortuneToday: String(d?.fortune?.lastDateKey || '') === today,
    totalDays: Number(d?.checkin?.totalDays) || 0,
    byGame: fresh ? {} : (dp.byGame || {}),
    cap,
    remaining: fresh ? { rps: cap, dice: cap } : {
      rps: Math.max(0, cap - (Number(dp.byGame?.rps) || 0)),
      dice: Math.max(0, cap - (Number(dp.byGame?.dice) || 0)),
    },
  };
}
