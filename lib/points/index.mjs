/**
 * points/index — 积分系统门面（2026-11-17）
 *
 * 接入层（卡片/命令/小店）只调这里，不直接碰 store/earn/spend。
 *
 * 主要 API：
 *   createPoints({dataRoot, cfg, logger}) → points 实例
 *   points.checkin(openid, name)          签到
 *   points.fortune(openid, score, dateKey) 抽签发分
 *   points.rps(openid, result)            猜拳结算
 *   points.dice(openid)                   骰子发分
 *   points.canPlay(openid, gameId)        还能不能得分
 *   points.pay / refund / payThenRun      消费
 *   points.balance(openid)                查余额
 *   points.status(openid)                 今日状态
 *   points.leaderboard(members)           本群榜
 *   points.clear(openid)                  清空（删档）
 */

import { DEFAULT_POINTS_CONFIG, mergePointsConfig, validatePointsConfig, fortunePointsOf } from './config.mjs';
import { createPointsStore, createEmptyPoints } from './store.mjs';
import {
  doCheckin, fromFortune, fromPlay, fromRps, canEarnPlay,
  getBalance, todayStatus, _resetCooldowns,
} from './earn.mjs';
import { pay, refund, payThenRun } from './spend.mjs';
import { topOfGroup, renderLeaderboard } from './leaderboard.mjs';
import { ERR, shopErr } from '../pure/errors.mjs';

/**
 * 创建积分实例。
 *
 * @param {{dataRoot:string, cfg?:object, logger?:object}} opts
 */
export function createPoints(opts = {}) {
  const cfg = mergePointsConfig(DEFAULT_POINTS_CONFIG, opts.cfg || {});
  const errs = validatePointsConfig(cfg);
  if (errs.length > 0) {
    throw shopErr(ERR.CONFIG_INVALID, `积分配置非法: ${errs.join('; ')}`, { errors: errs });
  }

  const store = createPointsStore({
    dataRoot: opts.dataRoot,
    cfg,
    logger: opts.logger,
  });

  return {
    cfg,
    store,

    // ── 获取 ──
    checkin: (openid, name, nowMs) => doCheckin(store, { openid, name, nowMs }),
    fortune: (openid, score, dateKey, name, nowMs) =>
      fromFortune(store, { openid, score, dateKey, name, nowMs }),
    rps: (openid, result, name, nowMs) => fromRps(store, { openid, result, name, nowMs }),
    dice: (openid, name, nowMs) => fromPlay(store, { openid, name, gameId: 'dice', nowMs }),
    canPlay: (openid, gameId, nowMs) => canEarnPlay(store, openid, gameId, nowMs),

    // ── 消费 ──
    pay: (openid, price, reason, name, nowMs) =>
      pay(store, { openid, price, reason, name, nowMs }),
    refund: (openid, amount, reason, name, nowMs) =>
      refund(store, { openid, amount, reason, name, nowMs }),
    payThenRun: (payOpts, run) => payThenRun(store, payOpts, run),

    // ── 查询 ──
    balance: (openid) => getBalance(store, openid),
    status: (openid, nowMs) => todayStatus(store, openid, nowMs),

    /** 读完整档案（诊断用）。 */
    profile(openid) {
      try { return store.read(openid); } catch { return null; }
    },

    // ── 排行榜 ──
    leaderboard(memberOpenids, o) {
      if (cfg.leaderboardEnabled !== true) return [];
      return topOfGroup(store, memberOpenids, o);
    },
    renderBoard: renderLeaderboard,

    // ── 管理 ──
    /** 清空某人积分（删档，可恢复：文件被改名而非删除）。 */
    clear(openid) {
      return store.remove(openid);
    },

    /** score → 积分（供卡片显示用）。 */
    pointsOfScore(score) {
      return fortunePointsOf(cfg, score);
    },

    // ── 测试用 ──
    _internal: { store, resetCooldowns: _resetCooldowns, createEmptyPoints },
  };
}

export { DEFAULT_POINTS_CONFIG, fortunePointsOf };