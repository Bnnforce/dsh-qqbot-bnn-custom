/**
 * wake-lottery/index — 编排层（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是外部（hook / 命令 / 卡片）唯一该 import 的文件。
 *
 * 它把六个模块串起来：
 *   core（判定） + config（参数） + store（状态） + atlas（图鉴）
 *   + prizes/registry（出口） + narrate（文案）
 *
 * 对外只暴露四个函数，其他都是内部细节。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, loadConfig } from './config.mjs';
import {
  shouldStart, adjustWeights, applyPity, pickMode, makeCycleId,
  dateKeyOf, hourOf,
} from './core.mjs';
import {
  readState, writeState, rolloverIfNeeded, readGlobalStats, bumpGlobalStats,
  inviteExpired, hashOpenid, readJsonSafe, diag, rootDir,
} from './store.mjs';
import { readAtlas, recordDraw, atlasSummary } from './atlas.mjs';
import { draw as drawPrize, availableOutlets } from './prizes/registry.mjs';
import { buildWakePrompt, buildInviteText, buildResultText, hhmmOf } from './narrate.mjs';

/* ──────────────────────────────────────────────────────────────
 * 配置加载（文件 + 环境变量）
 * ────────────────────────────────────────────────────────────── */

/** 配置文件路径。 */
export function configFile() {
  return join(rootDir(), 'config.json');
}

/**
 * 读配置（永不抛）。
 *
 * @returns {typeof DEFAULT_CONFIG}
 */
export function loadRuntimeConfig() {
  try {
    const file = configFile();
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    return loadConfig(raw);
  } catch {
    return loadConfig(null);
  }
}

/* ──────────────────────────────────────────────────────────────
 * 外部数据读取（只读，绝不写）
 * ────────────────────────────────────────────────────────────── */

/** persona 插件数据根。 */
function personaRoot() {
  const override = String(process.env.PERSONA_DATA_ROOT ?? '').trim();
  if (override) return override;
  const home = process.env.DSH_HOME || join(process.env.HOME || '{DSH_HOME}/files/home', '.dsh');
  return join(home, 'data', 'dsh-anti-ai-persona');
}

/**
 * 读某群心跳状态（**只读**）。
 *
 * @param {string} gid
 * @returns {object|null}
 */
export function readHeartbeat(gid) {
  try {
    const s = String(gid ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!s) return null;
    return readJsonSafe(join(personaRoot(), 'state', 'heartbeat', `${s}.json`));
  } catch {
    return null;
  }
}

/**
 * 读八维情绪（**只读**）。
 *
 * 过期（updatedAt 超 24h）→ 返回 null（回落基准权重）。
 *
 * @param {number} nowMs
 * @returns {object|null}
 */
export function readDims(nowMs) {
  try {
    const raw = readJsonSafe(join(personaRoot(), 'state', 'mood-axes.json'));
    if (!raw) return null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const updatedAt = Number(raw.updatedAt);
    if (Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt > 24 * 60 * 60 * 1000) {
      return null; // 过期
    }
    return raw;
  } catch {
    return null;
  }
}

/** 读群列表（gid → 群名），读不到返回空对象。 */
export function readGroups() {
  try {
    const home = process.env.DSH_HOME || join(process.env.HOME || '{DSH_HOME}/files/home', '.dsh');
    return readJsonSafe(join(home, 'qqbot', 'groups.json'))
      || readJsonSafe(join(process.env.QQBOT_DATA_ROOT || '', '.qqbot', 'groups.json'))
      || {};
  } catch {
    return {};
  }
}

/* ──────────────────────────────────────────────────────────────
 * 核心 API ①：检查并决定是否开始
 * ────────────────────────────────────────────────────────────── */

/**
 * 检查某群是否该开始一次唤醒抽奖。
 *
 * **注意**：它只做判定 + 写状态，**不发送任何消息**。
 * 发送由调用方（hook）根据 mode 决定。
 *
 * @param {{gid:string, nowMs?:number, cfg?:object}} ctx
 * @returns {Promise<{
 *   started:boolean, mode:'self'|'invite'|null, cycleId:string,
 *   reason:string, hhmm:string, quietMinutes:number
 * }>}
 */
export async function checkAndStart(ctx) {
  const cfg = ctx?.cfg || loadRuntimeConfig();
  const gid = String(ctx?.gid ?? '').trim();
  const now = Number.isFinite(Number(ctx?.nowMs)) ? Number(ctx.nowMs) : Date.now();

  if (!gid) return { started: false, mode: null, cycleId: '', reason: 'no-gid', hhmm: '', quietMinutes: 0 };
  if (!cfg.enabled) return { started: false, mode: null, cycleId: '', reason: 'disabled', hhmm: '', quietMinutes: 0 };

  // 读心跳（只读）
  const hb = readHeartbeat(gid);
  if (!hb) return { started: false, mode: null, cycleId: '', reason: 'no-heartbeat', hhmm: '', quietMinutes: 0 };

  // 读/滚动状态
  const today = dateKeyOf(now, cfg.timezone);
  const rolled = rolloverIfNeeded(readState(gid, now, cfg.timezone), now, cfg.timezone, dateKeyOf);
  let state = rolled.state;

  // 清理过期邀请（顺带）
  if (state.pendingInvite && inviteExpired(state, now, cfg.inviteExpireMs)) {
    diag(`[清理] gid=${gid} 邀请过期 cycle=${state.pendingInvite.cycleId}`);
    state.pendingInvite = null;
    writeState(gid, state);
  }

  // 全局计数
  const globalStats = readGlobalStats(now, cfg.timezone, dateKeyOf, hourOf);

  // 判定（10 条前置全在 core 里）
  const lastLottery = {
    lastAt: state.lastAt,
    dateKey: state.date,
    dailyCount: state.dailyCount,
  };
  const verdict = shouldStart({ heartbeat: hb, lastLottery, globalStats, nowMs: now }, cfg, now);
  if (!verdict.yes) {
    return { started: false, mode: null, cycleId: '', reason: verdict.reason, hhmm: '', quietMinutes: 0 };
  }

  // 生成 cycleId 并做幂等校验
  const cycleId = makeCycleId(now, gid, cfg.timezone);
  if (state.lastCycleId === cycleId) {
    return { started: false, mode: null, cycleId, reason: 'cycle-used', hhmm: '', quietMinutes: 0 };
  }

  // 选模式
  const mode = pickMode(cfg);

  // 写状态（原子）
  const quietMinutes = Number.isFinite(Number(hb.coldSetAt)) && hb.coldSetAt > 0
    ? Math.round((now - hb.coldSetAt) / 60000)
    : 0;

  state = {
    ...state,
    lastAt: now,
    dailyCount: state.dailyCount + 1,
    lastCycleId: cycleId,
    pendingInvite: mode === 'invite' ? { cycleId, at: now, cardId: '' } : null,
  };
  if (!writeState(gid, state)) {
    diag(`[状态] gid=${gid} 状态写入失败，放弃本次`);
    return { started: false, mode: null, cycleId, reason: 'state-write-failed', hhmm: '', quietMinutes };
  }
  bumpGlobalStats(now, cfg.timezone, dateKeyOf, hourOf);

  const hhmm = hhmmOf(now, cfg.timezone);
  diag(`[触发] gid=${gid} cycle=${cycleId} mode=${mode} quiet=${quietMinutes}min`);

  return { started: true, mode, cycleId, reason: 'ready', hhmm, quietMinutes };
}

/* ──────────────────────────────────────────────────────────────
 * 核心 API ②：执行一次抽奖
 * ────────────────────────────────────────────────────────────── */

/**
 * 执行一次抽奖并兑现。
 *
 * @param {{gid:string, openid:string, name?:string,
 *          cycleId?:string, nowMs?:number, cfg?:object,
 *          random?:()=>number, consumeInvite?:boolean}} ctx
 * @returns {Promise<{
 *   ok:boolean, prizeKey:string, payload:object,
 *   swapped:boolean, cycleId:string, reason:string,
 *   resultText:string, isNewForAtlas:boolean
 * }>}
 */
export async function executeDraw(ctx) {
  const cfg = ctx?.cfg || loadRuntimeConfig();
  const gid = String(ctx?.gid ?? '').trim();
  const openid = String(ctx?.openid ?? '').trim();
  const now = Number.isFinite(Number(ctx?.nowMs)) ? Number(ctx.nowMs) : Date.now();

  if (!gid || !openid) {
    return {
      ok: false, prizeKey: '', payload: {}, swapped: false, cycleId: '',
      reason: 'missing-args', resultText: '', isNewForAtlas: false,
    };
  }

  // 状态（用于保底计数 + 用户限次）
  const rolled = rolloverIfNeeded(readState(gid, now, cfg.timezone), now, cfg.timezone, dateKeyOf);
  let state = rolled.state;

  // 每人每天限次
  const hash = hashOpenid(openid, cfg.salt);
  const userRec = state.byUser[hash];
  const userCount = userRec && userRec.date === state.date ? Number(userRec.count) || 0 : 0;
  if (userCount >= cfg.perUserDailyCap) {
    return {
      ok: false, prizeKey: '', payload: {}, swapped: false,
      cycleId: ctx?.cycleId || state.lastCycleId, reason: 'user-daily-cap',
      resultText: '', isNewForAtlas: false,
    };
  }

  // 八维（过期/缺失 → null，回落基准权重）
  const dims = readDims(now);

  // 权重（八维调整 + 保底提权）
  const weights = adjustWeights(dims, cfg, state.pityCounter);

  // 抽 + 兑现（registry 内部处理可用池与换奖）
  const result = await drawPrize({
    gid,
    openid,
    name: ctx?.name || '',
    cfg,
    weights,
    random: ctx?.random,
    timeoutMs: cfg.prizeTimeoutMs,
    nowMs: now,
  });

  if (!result.ok) {
    diag(`[抽签] gid=${gid} 全部出口失败`);
    return {
      ok: false, prizeKey: '', payload: {}, swapped: false,
      cycleId: ctx?.cycleId || state.lastCycleId, reason: result.reason || 'draw-failed',
      resultText: '', isNewForAtlas: false,
    };
  }

  // 保底推进
  const pity = applyPity(result.prizeKey, state.pityCounter, cfg);

  // 状态更新
  state = {
    ...state,
    pityCounter: pity.pity,
    lastPrizeKey: result.prizeKey,
    byUser: {
      ...state.byUser,
      [hash]: { date: state.date, count: userCount + 1 },
    },
    pendingInvite: ctx?.consumeInvite === true ? null : state.pendingInvite,
  };
  writeState(gid, state);

  // 图鉴
  let isNewForAtlas = false;
  if (cfg.atlasEnabled) {
    try {
      const r = recordDraw(gid, hash, result.prizeKey, now);
      isNewForAtlas = r.isNew;
    } catch { /* 图鉴失败不影响抽奖 */ }
  }

  diag(`[抽签] gid=${gid} prize=${result.prizeKey} swapped=${result.swapped} pity=${pity.pity} forced=${pity.forced}`);

  return {
    ok: true,
    prizeKey: result.prizeKey,
    payload: result.payload,
    swapped: !!result.swapped,
    cycleId: ctx?.cycleId || state.lastCycleId,
    reason: 'ok',
    resultText: buildResultText(result, cfg),
    isNewForAtlas,
  };
}

/* ──────────────────────────────────────────────────────────────
 * 核心 API ③④：文案 / 图鉴
 * ────────────────────────────────────────────────────────────── */

/**
 * 构造 A 模式的 wake prompt。
 *
 * @param {{prizeKey:string, payload:object, hhmm:string, quietMinutes:number}} p
 * @param {object} [cfg]
 * @param {number} [nowMs]
 * @returns {string}
 */
export function buildNarration(p, cfg, nowMs) {
  const c = cfg || loadRuntimeConfig();
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const dims = readDims(now);
  return buildWakePrompt(p, dims, c);
}

/**
 * 读图鉴摘要。
 *
 * @param {string} gid
 * @param {string} openid
 * @param {object} [cfg]
 */
export function readAtlasFor(gid, openid, cfg) {
  const c = cfg || loadRuntimeConfig();
  if (!c.atlasEnabled) return { collected: [], total: 0, text: '图鉴未开启。' };
  const hash = hashOpenid(openid, c.salt);
  return atlasSummary(gid, hash, c);
}

/* ──────────────────────────────────────────────────────────────
 * 辅助导出（给 hook / 命令用）
 * ────────────────────────────────────────────────────────────── */

export { buildInviteText, buildResultText, hhmmOf, availableOutlets, readState, writeState, hashOpenid, diag };
export const VERSION = '1.0.0';

export default {
  VERSION,
  loadRuntimeConfig, configFile,
  readHeartbeat, readDims, readGroups,
  checkAndStart, executeDraw, buildNarration, readAtlasFor,
  buildInviteText, buildResultText, hhmmOf,
  availableOutlets, hashOpenid, diag,
};
