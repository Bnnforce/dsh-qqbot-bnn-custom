/**
 * shop/time — 时间口径统一（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独抽这个模块：
 *
 *   现有代码里存在这种写法（实测见过）：
 *     new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
 *   手动加 8 小时来"得到北京时间"——一旦 timezone 不是 +08:00 就全错，
 *   而且和 Intl.DateTimeFormat 混用时会出现**两种口径不一致**。
 *
 *   本模块只提供一个口径：**用 Intl.DateTimeFormat + 配置里的 timezone**。
 *   所有需要"现在是几点/今天是哪天"的地方都走这里。
 *
 * 不复用 r4/time.ts 的原因：那个属于插件内部（TS），扩展包（.mjs）跨包引用
 * 会把依赖绑死；这里只有 60 行，独立一份更干净。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 把时间戳格式化成指定时区下的各部分。
 *
 * @param {number} ms 时间戳
 * @param {string} timeZone IANA 时区（如 'Asia/Shanghai'）
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,dateKey:string}}
 */
export function zonedParts(ms, timeZone = 'Asia/Shanghai') {
  const d = new Date(Number(ms) || Date.now());
  let parts;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    parts = fmt.formatToParts(d);
  } catch {
    // 时区名非法 → 退回 UTC（不阻断）
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
  }
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') % 24;
  const minute = get('minute');
  return {
    year, month, day, hour, minute,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** 当前时区下的日期键 'YYYY-MM-DD'。 */
export function dateKeyOf(ms, timeZone) {
  return zonedParts(ms, timeZone).dateKey;
}

/** 当前时区下的月份键 'YYYY-MM'（归档用）。 */
export function monthKeyOf(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** 两个时间戳是不是同一个"本地日"。 */
export function isSameDay(a, b, timeZone) {
  return dateKeyOf(a, timeZone) === dateKeyOf(b, timeZone);
}

/** 当前时区下的小时（0-23）。 */
export function hourOf(ms, timeZone) {
  return zonedParts(ms, timeZone).hour;
}

/**
 * 在窗口内随机一个时间戳（当天下）。
 *
 * 用途：开店/打烊不要在固定时刻触发，而是在窗口内随机。
 *
 * @param {number} nowMs 当前时间
 * @param {{startHour:number,startMin:number,endHour:number,endMin:number}} win
 * @param {string} timeZone
 * @param {() => number} random 0-1 随机源（便于测试注入）
 * @returns {number} 目标时间戳
 */
export function randomWithinWindow(nowMs, win, timeZone = 'Asia/Shanghai', random = Math.random) {
  const p = zonedParts(nowMs, timeZone);
  const startMin = win.startHour * 60 + win.startMin;
  const endMin = win.endHour * 60 + win.endMin;
  const span = Math.max(0, endMin - startMin);
  const pick = startMin + Math.floor(random() * (span + 1));
  const nowMin = p.hour * 60 + p.minute;
  // 已经过了窗口 → 立即（不往后推，由调用方决定要不要说）
  if (nowMin >= pick) return nowMs;
  // 还没到 → 算出还要等多少毫秒
  const waitMin = pick - nowMin;
  return nowMs + waitMin * 60_000;
}

/** 转成带时区的 ISO 字符串（存档里用，便于人看）。 */
export function toZonedIso(ms, timeZone = 'Asia/Shanghai') {
  // 用偏移量拼，避免依赖 toLocaleString 的格式差异
  const d = new Date(Number(ms) || Date.now());
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const p = fmt.formatToParts(d);
    const get = (t) => p.find((x) => x.type === t)?.value ?? '00';
    const local = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
    const offsetMin = tzOffsetMinutes(d, timeZone);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const oh = String(Math.floor(abs / 60)).padStart(2, '0');
    const om = String(abs % 60).padStart(2, '0');
    return `${local}${sign}${oh}:${om}`;
  } catch {
    return d.toISOString();
  }
}

/** 某时刻在某时区相对 UTC 的偏移（分钟）。 */
function tzOffsetMinutes(d, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(d);
    const get = (t) => Number(parts.find((x) => x.type === t)?.value ?? 0);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asUTC - d.getTime()) / 60_000);
  } catch {
    return 0;
  }
}