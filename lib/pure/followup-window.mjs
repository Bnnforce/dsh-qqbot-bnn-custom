/**
 * followup-window — 「免@追问窗口」状态机
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 要解决的问题
 *
 *   群里 @ 她一次之后，接下来的 2-3 句是连着说的，但每句都得重新 @ ——
 *   很反人类。有了这个窗口，@ 一次就够她说完整段对话。
 *
 * ── 为什么不用改写 ctx.platform.mentioned ─────────────────────────────────
 *
 *   上游的 platform 是 **getter**：
 *     get platform() { return { mentioned: platformMentioned(ctx, ...) }; }
 *   每次访问重新计算，**赋值无效**（实测确认）。
 *
 *   所以改方案：本模块只维护「窗口状态」，由门禁 hook 主动查询。
 *   门禁本来就是判断"要不要放行"的地方，读一个额外条件很自然。
 *
 * ── 安全边界（这几条是防"她在群里自说自话"的）────────────────────────────
 *
 *   ① **按「群 × 用户」隔离** —— A 开的窗口不能被 B 用
 *   ② **轮次上限** —— 窗口内最多再免 @ 几轮（默认 2），用完即关
 *   ③ **时间上限** —— 默认 5 分钟
 *   ④ 每次免 @ 使用都会消耗轮次，防止无限续期
 *
 * ── 共享协议 ──────────────────────────────────────────────────────────────
 *
 *   插件与扩展包是两套加载体系，靠 globalThis + Symbol 传状态
 *   （与 recent-user-text / recent-media 同一做法）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

const KEY = Symbol.for('qqbot.followup-window.v1');

/** 默认窗口 5 分钟。 */
export const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
/** 默认窗口内最多免 @ 的轮次。 */
export const DEFAULT_MAX_TURNS = 2;
/** 最多跟踪多少个「群×用户」。 */
const MAX_KEYS = 500;

function store() {
  let m = globalThis[KEY];
  if (!(m instanceof Map)) { m = new Map(); globalThis[KEY] = m; }
  return m;
}

/** key = `gid|uid` —— 按群 × 用户隔离。 */
export function keyOf(gid, uid) {
  const g = String(gid ?? '').trim();
  const u = String(uid ?? '').trim();
  if (!g || !u) return '';
  return `${g}|${u}`;
}

/**
 * 开（或续）一个窗口。
 *
 * @param {string} gid
 * @param {string} uid
 * @param {object} [opts]
 * @param {number} [opts.windowMs]
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.now]
 * @returns {boolean}
 */
export function open(gid, uid, opts = {}) {
  try {
    const key = keyOf(gid, uid);
    if (!key) return false;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const windowMs = Math.max(1000, Number(opts.windowMs) || DEFAULT_WINDOW_MS);
    const maxTurns = Math.max(0, Math.floor(Number(opts.maxTurns ?? DEFAULT_MAX_TURNS)));

    const m = store();
    if (m.size >= MAX_KEYS && !m.has(key)) {
      // 清掉最旧的一批（Map 保持插入顺序）
      let i = 0;
      for (const k of m.keys()) {
        if (i >= Math.ceil(MAX_KEYS / 4)) break;
        m.delete(k);
        i += 1;
      }
    }
    m.set(key, { until: now + windowMs, turnsLeft: maxTurns, openedAt: now });
    return true;
  } catch {
    return false;
  }
}

/**
 * 查窗口是否可用（**不消耗轮次**，只读）。
 *
 * @returns {{ ok: boolean, turnsLeft: number, msLeft: number }}
 */
export function peek(gid, uid, now = Date.now()) {
  try {
    const key = keyOf(gid, uid);
    if (!key) return { ok: false, turnsLeft: 0, msLeft: 0 };
    const m = store();
    const hit = m.get(key);
    if (!hit) return { ok: false, turnsLeft: 0, msLeft: 0 };
    const msLeft = Number(hit.until) - now;
    if (msLeft <= 0 || Number(hit.turnsLeft) <= 0) {
      m.delete(key);                       // 过期或轮次用完 → 清掉
      return { ok: false, turnsLeft: 0, msLeft: 0 };
    }
    return { ok: true, turnsLeft: Number(hit.turnsLeft), msLeft };
  } catch {
    return { ok: false, turnsLeft: 0, msLeft: 0 };
  }
}

/**
 * 消耗一轮（窗口内真的免 @ 放行了一次时调）。
 *
 * @returns {boolean} 是否消耗成功（false = 窗口不可用）
 */
export function consume(gid, uid, now = Date.now()) {
  try {
    const key = keyOf(gid, uid);
    if (!key) return false;
    const m = store();
    const hit = m.get(key);
    if (!hit) return false;
    if (Number(hit.until) - now <= 0) { m.delete(key); return false; }
    const left = Number(hit.turnsLeft) - 1;
    if (left <= 0) { m.delete(key); return true; }   // 最后一轮用完即关
    hit.turnsLeft = left;
    m.set(key, hit);
    return true;
  } catch {
    return false;
  }
}

/** 关掉窗口（比如她明确说了"我先去忙"）。 */
export function close(gid, uid) {
  try {
    const key = keyOf(gid, uid);
    if (!key) return false;
    return store().delete(key);
  } catch {
    return false;
  }
}

/** 清空（测试用）。 */
export function clearAll() {
  try { store().clear(); } catch { /* ignore */ }
}

export default { open, peek, consume, close, clearAll, keyOf, DEFAULT_WINDOW_MS, DEFAULT_MAX_TURNS };
