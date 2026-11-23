/**
 * 今日行程 / 定时提醒 共享逻辑
 * 存储：{dataRoot}/.qqbot-extensions/data/itinerary/people/<openid>.json
 * 一人一文件，读取/写入都按 owner 隔离；主人查询他人时显式读目标文件。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TZ = 'Asia/Shanghai';
export const MAX_PENDING = 50;
export const MAX_HISTORY = 100;
const DATA_SUBDIR = join('.qqbot-extensions', 'data', 'itinerary', 'people');

export function dataRootOf(x) {
  return String(x?.dataRoot || x?.caps?.dataRoot || '').trim();
}
export function peopleDir(root) {
  return join(root, DATA_SUBDIR);
}
function safeId(openid) {
  return encodeURIComponent(String(openid || '').trim()).replace(/%/g, '_');
}
export function personFile(root, openid) {
  return join(peopleDir(root), `${safeId(openid)}.json`);
}
export function emptyPerson(owner = '') {
  return { version: 1, owner, pending: [], history: [], unsent: [], lastView: null };
}
export function loadPerson(root, owner) {
  try {
    const j = JSON.parse(readFileSync(personFile(root, owner), 'utf8'));
    return {
      version: 1,
      owner: String(j.owner || owner),
      pending: Array.isArray(j.pending) ? j.pending : [],
      history: Array.isArray(j.history) ? j.history : [],
      unsent: Array.isArray(j.unsent) ? j.unsent : [],
      lastView: j.lastView && typeof j.lastView === 'object' ? j.lastView : null,
    };
  } catch { return emptyPerson(owner); }
}
export function savePerson(root, person) {
  const p = personFile(root, person.owner);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(person, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}
export function listPeople(root) {
  const dir = peopleDir(root);
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (j && typeof j === 'object' && Array.isArray(j.pending)) {
          out.push({
            version: 1, owner: String(j.owner || ''),
            pending: j.pending, history: Array.isArray(j.history) ? j.history : [],
            unsent: Array.isArray(j.unsent) ? j.unsent : [],
            lastView: j.lastView && typeof j.lastView === 'object' ? j.lastView : null,
          });
        }
      } catch { /* skip bad */ }
    }
  } catch { /* no dir */ }
  return out;
}
export function todayParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: p.weekday };
}
export function localStamp(ms) {
  const d = new Date(ms);
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function utcOfLocal(y, m, d, hh, mm) {
  // Asia/Shanghai 固定 UTC+8（无夏令时），用 UTC 反推稳定。
  return Date.UTC(y, m - 1, d, hh - 8, mm, 0, 0);
}
function nextWeekday(target, now) {
  const parts = todayParts(now);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const cur = map[parts.weekday] ?? new Date(now).getUTCDay();
  let delta = (target - cur + 7) % 7;
  if (delta === 0) delta = 7;
  return delta;
}
/**
 * 自然语言时间解析。返回 {ok, fireAt, label, rest}。
 * 支持：30秒/分钟/小时后、明天/后天、周一、HH:mm、M月D日、YYYY-MM-DD HH:mm。
 */
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnInt(raw) {
  const s = String(raw || '').replace(/[百百]/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  if (!s.includes('十')) return CN_DIGIT[s] ?? NaN;
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (CN_DIGIT[s[1]] ?? 0);
  const m = /^([一二两三四五六七八九]?)(?:十([一二两三四五六七八九]?))?$/.exec(s);
  if (!m) return NaN;
  const tens = m[2] === undefined ? (m[1] ? 0 : NaN) : (m[1] ? CN_DIGIT[m[1]] : 1) * 10;
  if (Number.isNaN(tens)) return NaN;
  return tens + (m[2] === '' ? 0 : (CN_DIGIT[m[2]] ?? 0));
}
function normalizeCnTime(input) {
  let s = String(input ?? '');
  // 常用相对日期口语
  s = s.replace(/今晚/g, '今天晚上')
    .replace(/明晚/g, '明天晚上')
    .replace(/今早/g, '今天早上')
    .replace(/明早/g, '明天早上');
  // 中文数字只转「点/时/分」前面的，避免误伤普通数字
  s = s.replace(/([零〇一二两三四五六七八九十]+)\s*(?=点|时|分)/g, (m) => {
    const n = cnInt(m);
    return Number.isFinite(n) ? String(n) : m;
  });
  return s;
}
function periodHour(period, h) {
  if (!period) return h;
  if (/凌晨/.test(period)) return h === 12 ? 0 : h;
  if (/下午|傍晚|晚上|夜里|晚/.test(period)) return h < 12 ? h + 12 : h;
  if (/中午/.test(period)) return h < 12 ? h + 12 : h;
  return h;
}
function parseClockSegment(text) {
  let s = String(text ?? '').trim();
  let period = '';
  let periodLen = 0;
  let periodText = '';
  const pm = /^(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|晚)\s*/.exec(s);
  if (pm) { period = pm[1]; periodText = pm[0]; periodLen = pm[0].length; s = s.slice(periodLen); }

  // 21:10 / 21.10 / 21：10
  let m = /^(\d{1,2})\s*[:：.]\s*(\d{1,2})\s*(?:分)?\s*/.exec(s);
  if (m) {
    let hh = Number(m[1]);
    let mm = Number(m[2]);
    if (hh > 23 || mm > 59) return { ok: false };
    hh = periodHour(period, hh);
    return { ok: true, hh, mm, consumed: periodText + m[0] };
  }
  // 9点 / 9点10 / 9点10分 / 9点半 / 9点一刻 / 9时
  m = /^(\d{1,2})\s*(?:点|时)\s*(\d{1,2})?\s*(半|一刻|三刻|分)?\s*/.exec(s);
  if (m) {
    let hh = Number(m[1]);
    let mm = m[2] === undefined ? 0 : Number(m[2]);
    if (m[3] === '半') mm = 30;
    else if (m[3] === '一刻') mm = 15;
    else if (m[3] === '三刻') mm = 45;
    if (hh > 23 || mm > 59) return { ok: false };
    hh = periodHour(period, hh);
    return { ok: true, hh, mm, consumed: periodText + m[0] };
  }
  return { ok: false };
}

export function parseTime(input, now = new Date()) {
  let s = String(input ?? '').trim()
    .replace(/[，,]/g, ' ')
    .replace(/：/g, ':')
    .replace(/．/g, '.')
    .replace(/\s+/g, ' ');
  if (!s) return { ok: false, msg: '没给时间' };
  s = normalizeCnTime(s);

  // 过两分钟 / 过三天 / 过半小时
  const relCn = /^过\s*([零〇一二两三四五六七八九十\d]+|半)\s*(秒钟?|分钟?|小时|天|日)\s*(?:后|之后)?\s*/i.exec(s);
  if (relCn) {
    const rawN = relCn[1];
    const n = rawN === '半' ? 0.5 : cnInt(rawN);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, msg: '时间要大于 0' };
    const unit = relCn[2];
    const ms = /秒/.test(unit) ? n * 1000
      : /小时/.test(unit) ? n * 3600000
      : /天|日/.test(unit) ? n * 86400000
      : n * 60000;
    const fireAt = now.getTime() + ms;
    return { ok: true, fireAt, label: localStamp(fireAt), rest: s.slice(relCn[0].length).trim() };
  }

  // 相对时间：30分钟后 / 2小时后
  const rel = /^(\d+)\s*(秒钟?|分钟?|小时)\s*(?:后|之后)\s*/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = /秒/.test(unit) ? n * 1000 : /小时/.test(unit) ? n * 3600000 : n * 60000;
    if (!Number.isFinite(ms) || ms <= 0) return { ok: false, msg: '时间要大于 0' };
    const fireAt = now.getTime() + ms;
    return { ok: true, fireAt, label: localStamp(fireAt), rest: s.slice(rel[0].length).trim() };
  }

  const parts = todayParts(now);
  let y = parts.y, m = parts.m, d = parts.d;
  let consumed = '';

  // 绝对日期：YYYY-MM-DD / YYYY/MM/DD
  const dateAbs = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*/.exec(s);
  if (dateAbs) {
    y = Number(dateAbs[1]); m = Number(dateAbs[2]); d = Number(dateAbs[3]);
    consumed = dateAbs[0];
  } else {
    // 月日：10月28日（点号留给 21.10 这种时间写法）
    const dateCn = /^(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*/.exec(s);
    if (dateCn) {
      m = Number(dateCn[1]); d = Number(dateCn[2]);
      consumed = dateCn[0];
    } else {
      // 今天/明天/后天/大后天/周几/星期几
      const day = /^(今天|明天|后天|大后天|(?:周|星期)([一二三四五六日天]))\s*/.exec(s);
      if (day) {
        consumed = day[0];
        if (day[1] === '明天') d += 1;
        else if (day[1] === '后天') d += 2;
        else if (day[1] === '大后天') d += 3;
        else if (day[2]) {
          const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
          const delta = nextWeekday(map[day[2]], now);
          d += delta;
        }
      }
    }
  }

  // 日期后 / 无日期的时间部分
  const rest = s.slice(consumed.length).trim();
  const clock = parseClockSegment(rest);
  if (!clock.ok) {
    if (/明天|今天|后天|周|星期/.test(consumed)) return { ok: false, msg: '日期有了，还要给个几点几分，比如「明天早上9点10分」' };
    return { ok: false, msg: '没看懂这个时间。可以说「明天早上9点10分」「明天 21:10」「后天下午3点半」「30分钟后」。' };
  }
  if (clock.hh > 23 || clock.mm > 59) return { ok: false, msg: '时间格式不对，小时 0-23、分钟 0-59。' };

  // 归一化月末/跨月日期
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  y = base.getUTCFullYear(); m = base.getUTCMonth() + 1; d = base.getUTCDate();
  let fireAt = utcOfLocal(y, m, d, clock.hh, clock.mm);
  if (!consumed && fireAt < now.getTime()) fireAt += 86400000;
  if (fireAt < now.getTime()) return { ok: false, msg: '这个时间已经过去了，要不要说明天？' };
  const eventText = rest.slice(clock.consumed.length).trim();
  return { ok: true, fireAt, label: localStamp(fireAt), rest: eventText.replace(/^[-—:：\s]+/, '') };
}

export function makeId(now = Date.now()) {
  return `s_${now}_${Math.random().toString(36).slice(2, 6)}`;
}
export function findByIdPrefix(list, prefix) {
  const p = String(prefix ?? '').trim();
  if (!p) return null;
  return list.find((x) => String(x.id) === p) || list.find((x) => String(x.id).startsWith(p)) || null;
}
export function addPending(person, item) {
  person.pending = Array.isArray(person.pending) ? person.pending : [];
  if (person.pending.length >= MAX_PENDING) return { ok: false, msg: `每个人最多 ${MAX_PENDING} 条行程，先删几条吧` };
  const dup = person.pending.find((x) => x.owner === item.owner && Number(x.fireAt) === Number(item.fireAt) && String(x.text) === String(item.text));
  if (dup) return { ok: false, duplicate: true, item: dup, msg: `这条已经有了：${dup.id.slice(0, 6)}` };
  person.pending.push(item);
  person.pending.sort((a, b) => Number(a.fireAt) - Number(b.fireAt));
  return { ok: true, item };
}
export function pushHistory(person, row) {
  person.history = Array.isArray(person.history) ? person.history : [];
  person.history.push(row);
  if (person.history.length > MAX_HISTORY) person.history = person.history.slice(-MAX_HISTORY);
}
export function formatPending(list, title = '行程') {
  if (!list.length) return `${title}：空`;
  const lines = [`📅 ${title}（${list.length} 条）`];
  list.forEach((x, i) => {
    const rep = x.repeat && x.repeat !== 'once' ? `（${x.repeat === 'daily' ? '每天' : '工作日'}）` : '';
    lines.push(`${i + 1}. ${localStamp(x.fireAt).slice(5)} ${x.text}${rep}`);
  });
  return lines.join('\n');
}
export function daysWindow(now, which) {
  const parts = todayParts(now);
  const start = utcOfLocal(parts.y, parts.m, parts.d, 0, 0);
  if (which === 'today') return [start, start + 86400000];
  if (which === 'tomorrow') return [start + 86400000, start + 2 * 86400000];
  if (which === 'week') return [start, start + 7 * 86400000];
  return [0, Number.MAX_SAFE_INTEGER];
}
export function nextRepeat(item, now = Date.now()) {
  const cur = new Date(Number(item.fireAt) || now);
  if (item.repeat === 'weekday') {
    let t = Number(item.fireAt) + 86400000;
    for (let i = 0; i < 10; i++) {
      const parts = todayParts(new Date(t));
      const wd = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 12)).getUTCDay();
      if (wd >= 1 && wd <= 5) return t;
      t += 86400000;
    }
    return Number(item.fireAt) + 86400000;
  }
  return Number(item.fireAt) + 86400000;
}
