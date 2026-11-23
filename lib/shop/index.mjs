/**
 * shop/index — 小店的对外门面（2026-11-17）
 *
 * 接入层（botplay/hooks）只调这里，不直接碰 core/adapters。
 * 这样以后换存储、换文案引擎、加功能，接入层都不用改。
 *
 * 主要 API：
 *   createShop({dataRoot, personaRoot, cfg, logger, llm}) → shop 实例
 *   shop.ensure(gid, {personaName})          确保存档存在
 *   shop.open(gid, {personaName, nowMs})     开店
 *   shop.close(gid, {nowMs})                 打烊
 *   shop.order(gid, user, item, qty)         点单
 *   shop.snapshot(gid)                       取当前状态（给卡片/提示用）
 *   shop.handleReply(gid, user, replyText)   处理模型回复里的成交标记
 *   shop.switchPersona(gid, {toPersona})     切人格
 *   shop.forget(gid, openid)                 忘记我
 *   shop.diagnose(gid)                       诊断
 */

import { DEFAULT_CONFIG, mergeConfig, validateConfig } from './config.mjs';
import { ERR, ShopError, toShopError } from './errors.mjs';
import { toZonedIso } from './time.mjs';
import { createFsStore } from './adapters/store-fs.mjs';
import { buildMenu } from './adapters/menu-persona.mjs';
import { generateCopy } from './adapters/copy-template.mjs';
import {
  readState, writeState, ensureState, switchPersonaState, openedOnDate,
} from './core/state.mjs';
import { placeOrder, parseSoldMarkers, stripSoldMarkers, noteCustomer } from './core/order.mjs';
import { openShop, closeShop, shouldOpenNow, shouldCloseNow } from './core/daycycle.mjs';
import { rollEvent, recordEvent, bumpRegulars, EVENT_KINDS } from './core/event.mjs';

/** 店名生成（从群名派生；失败用兜底）。 */
export function deriveShopName(groupName, personaName, cfg) {
  const maxLen = Number(cfg?.maxShopNameLength) || 12;
  const g = String(groupName ?? '').trim();
  // 禁止含人格名（切人格时会矛盾）
  const banned = [String(personaName ?? '').trim(), '爱莉希雅', '比安安', 'GPT'].filter(Boolean);
  const hasBanned = (s) => banned.some((b) => b && s.includes(b));

  let name = g ? `${g}小店` : '小店';
  if (hasBanned(name)) name = '小店';
  if (name.length > maxLen) name = name.slice(0, maxLen);
  return name;
}

/**
 * 创建 shop 实例。
 *
 * @param {{dataRoot:string, personaRoot?:string, cfg?:object, logger?:object, llm?:object, random?:()=>number}} opts
 */
export function createShop(opts = {}) {
  const cfg = mergeConfig(DEFAULT_CONFIG, opts.cfg || {});
  const cfgErrs = validateConfig(cfg);
  if (cfgErrs.length > 0) {
    throw new ShopError(ERR.CONFIG_INVALID, `配置非法: ${cfgErrs.join('; ')}`, { errors: cfgErrs });
  }
  const logger = opts.logger;
  const llm = opts.llm;
  const personaRoot = opts.personaRoot;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  const store = createFsStore({
    dataRoot: opts.dataRoot,
    timezone: cfg.timezone,
    logger,
  });

  const tz = () => cfg.timezone;

  /** 取当前状态（不存在返回 null）。 */
  function snapshot(gid) {
    try { return readState(store, gid); } catch { return null; }
  }

  /** 确保存档存在；返回 state。 */
  async function ensure(gid, p = {}) {
    const personaName = String(p.personaName ?? '').trim() || '未命名';
    const nowMs = p.nowMs ?? Date.now();
    // 读不到存档 → 生成菜单 + 店名，初始化
    let menu = [];
    try {
      menu = await buildMenu({ personaName, personaRoot, cfg, random, logger });
    } catch (e) {
      logger?.warn?.(`[shop] 生成菜单失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    const shopName = deriveShopName(p.groupName, personaName, cfg);
    const { state } = await ensureState(store, gid, {
      personaName, menu, shopName, nowMs, timezone: tz(),
    });
    return state;
  }

  /**
   * 开店。
   * @returns {Promise<{ok:boolean, reason?:string, state?:object, copy?:string, event?:object}>}
   */
  async function open(gid, p = {}) {
    const nowMs = p.nowMs ?? Date.now();
    const personaName = String(p.personaName ?? '').trim();

    // 先确保存档
    let cur = snapshot(gid);
    if (!cur) cur = await ensure(gid, { personaName, groupName: p.groupName, nowMs });

    const decision = shouldOpenNow({ state: cur, nowMs, timezone: tz() });
    if (!decision.should) return { ok: false, reason: decision.reason, state: cur };

    // 生成今日菜单
    let menu = [];
    try {
      menu = await buildMenu({ personaName: personaName || cur.currentPersona, personaRoot, cfg, random, logger });
    } catch (e) {
      logger?.warn?.(`[shop] 菜单生成失败，用旧库存: ${e instanceof Error ? e.message : String(e)}`);
      menu = Object.entries(cur.dailyStock || {}).map(([name, v]) => ({ name, price: v.price, qty: v.qty }));
    }

    const r = await openShop(store, gid, {
      menu, personaName: personaName || cur.currentPersona, nowMs, timezone: tz(),
      silent: p.silent === true,
    });
    if (!r.ok) return r;

    // roll 事件
    let event = null;
    try {
      const rolled = rollEvent({ phase: 'open', state: r.state, cfg, random });
      if (rolled) {
        event = rolled;
        await recordEvent(store, gid, { kind: rolled.kind, meta: rolled.meta }, { nowMs, timezone: tz(), maxRecentEvents: cfg.maxRecentEvents });
      }
    } catch { /* 事件失败不阻断 */ }

    // 生成文案
    let copy = '';
    try {
      const g = await generateCopy({
        kind: 'open', state: r.state, persona: r.state.currentPersona, cfg, llm, random,
      });
      copy = g.text;
    } catch (e) {
      logger?.warn?.(`[shop] 开店文案失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { ok: true, state: r.state, copy, event };
  }

  /**
   * 打烊。
   */
  async function close(gid, p = {}) {
    const nowMs = p.nowMs ?? Date.now();
    const cur = snapshot(gid);
    if (!cur) return { ok: false, reason: ERR.STORE_READ_FAILED };

    const decision = shouldCloseNow({ state: cur, nowMs, timezone: tz() });
    if (!decision.should) return { ok: false, reason: decision.reason, state: cur };

    // 先 roll 事件（要放进文案里）
    let event = null;
    try {
      const rolled = rollEvent({ phase: 'close', state: cur, cfg, random });
      if (rolled) event = rolled;
    } catch { /* ignore */ }

    const r = await closeShop(store, gid, { nowMs, timezone: tz() });
    if (!r.ok) return r;

    if (event) {
      try {
        await recordEvent(store, gid, { kind: event.kind, meta: event.meta }, { nowMs, timezone: tz(), maxRecentEvents: cfg.maxRecentEvents });
      } catch { /* ignore */ }
    }

    let copy = '';
    try {
      const g = await generateCopy({
        kind: 'close', state: r.state, persona: r.state.currentPersona, cfg, llm, random,
        meta: event ? { eventKind: event.kind, ...event.meta } : undefined,
      });
      copy = g.text;
      // 事件文案单独一段（让它更显眼）
      if (event) {
        const ev = await generateCopy({
          kind: 'event', state: r.state, persona: r.state.currentPersona, cfg, llm, random,
          meta: { eventKind: event.kind, ...event.meta },
        });
        if (ev.text) copy = `${copy}${ev.text}`;
      }
    } catch (e) {
      logger?.warn?.(`[shop] 打烊文案失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { ok: true, state: r.state, revenue: r.revenue, sold: r.sold, copy, event };
  }

  /** 点单。 */
  async function order(gid, user, item, qty = 1) {
    return placeOrder(store, gid, user, item, qty, {
      nowMs: Date.now(), timezone: tz(),
      allowOversell: cfg.allowOversell === true,
      maxRegulars: cfg.maxRegulars,
      maxCustomerNotes: cfg.maxCustomerNotes,
    });
  }

  /**
   * 处理模型回复里的成交标记：扣库存 + 剥掉标记。
   *
   * @returns {Promise<{reply:string, orders:Array, failed:Array}>}
   */
  async function handleReply(gid, user, replyText) {
    const markers = parseSoldMarkers(replyText);
    const stripped = stripSoldMarkers(replyText);
    const orders = [];
    const failed = [];
    for (const m of markers) {
      // eslint-disable-next-line no-await-in-loop
      const r = await order(gid, user, m.item, m.qty);
      if (r.ok) {
        orders.push({ ...m, left: r.left });
        try { await bumpRegulars(store, gid, user.openid, { nowMs: Date.now(), timezone: tz(), maxRegulars: cfg.maxRegulars }); } catch { /* ignore */ }
      } else {
        failed.push({ ...m, reason: r.reason });
      }
    }
    return { reply: stripped, orders, failed };
  }

  /** 切人格（重建菜单 + 记任期）。 */
  async function switchPersona(gid, p = {}) {
    const toPersona = String(p.toPersona ?? '').trim();
    if (!toPersona) throw new ShopError(ERR.INVALID_ARG, '需要 toPersona');
    const nowMs = p.nowMs ?? Date.now();

    return store.withLock(gid, async () => {
      const s = readState(store, gid);
      if (!s) return { ok: false, reason: ERR.STORE_READ_FAILED };

      let menu = [];
      try {
        menu = await buildMenu({ personaName: toPersona, personaRoot, cfg, random, logger });
      } catch { menu = []; }

      const next = switchPersonaState(s, {
        toPersona, newMenu: menu, nowMs, timezone: tz(),
      });
      writeState(store, gid, next);
      try {
        store.appendHistory(gid, {
          v: 1, ts: toZonedIso(nowMs, tz()), t: 'switch',
          from: s.currentPersona, to: toPersona,
        });
      } catch { /* ignore */ }
      return { ok: true, state: next };
    });
  }

  /** 忘记我（删个人档案 + 全局标记）。 */
  function forget(gid, openid) {
    try { return store.forgetCustomer(gid, openid); } catch { return 0; }
  }

  /** 记一条顾客小事。 */
  function note(gid, openid, text) {
    return noteCustomer(store, gid, openid, text, {
      nowMs: Date.now(), timezone: tz(), maxCustomerNotes: cfg.maxCustomerNotes,
    });
  }

  /** 归档旧流水。 */
  function archive(gid, nowMs = Date.now()) {
    try { return store.archiveOldHistory(gid, nowMs); } catch { return { moved: 0, archivedTo: null }; }
  }

  /** 诊断。 */
  function diagnose(gid) {
    const s = snapshot(gid);
    return {
      enabled: cfg.enabled === true,
      dataRoot: store.dataRoot,
      hasState: !!s,
      day: s?.day ?? null,
      persona: s?.currentPersona ?? null,
      openToday: s?.openToday ?? null,
      lastOpen: s?.lastOpen ?? null,
      lastClose: s?.lastClose ?? null,
      stockLeft: s ? Object.values(s.dailyStock || {}).reduce((a, b) => a + (Number(b.qty) || 0), 0) : 0,
    };
  }

  return {
    cfg, store,
    ensure, open, close, order, handleReply, switchPersona,
    forget, note, archive, snapshot, diagnose,
    // 透出给测试/接入层
    _internal: { store, deriveShopName },
  };
}

export { EVENT_KINDS };