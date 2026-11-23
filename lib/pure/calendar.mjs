/**
 * calendar.mjs — 今日日历（公历 / 农历 / 干支 / 宜忌 / 冲煞 / 节日 / 节气）
 *
 * 数据来源：lunar-javascript 1.7.7（MIT，见 lib/lunar/LICENSE，已内嵌到 lib/lunar/lunar.js）
 * 全部离线计算，不依赖网络；时间固定按 Asia/Shanghai。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Solar = null;
try {
  ({ Solar } = require('../lunar/lunar.js'));
} catch {
  Solar = null;
}

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const MAX_ITEMS = 8;

function pad2(n) { return String(n).padStart(2, '0'); }
function uniq(list) { return [...new Set(list.filter(Boolean))]; }

/** 取 Asia/Shanghai 的今天（不依赖宿主机时区） */
export function shanghaiToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

function solarOf(y, m, d) {
  return Solar.fromYmd(y, m, d);
}

/** 扫描接下来 N 天的节日（公历 + 农历），返回最近几个 */
function nextFestivals(y, m, d, days = 75, limit = 4) {
  if (!Solar) return [];
  const base = Date.UTC(y, m - 1, d, 4); // 北京时间中午 = UTC 04:00
  const out = [];
  const seen = new Set();
  for (let i = 1; i <= days; i++) {
    const dt = new Date(base + i * 86400000);
    const yy = dt.getUTCFullYear();
    const mm = dt.getUTCMonth() + 1;
    const dd = dt.getUTCDate();
    try {
      const s = Solar.fromYmd(yy, mm, dd);
      const l = s.getLunar();
      const names = uniq([...(s.getFestivals() || []), ...(l.getFestivals() || [])]);
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, y: yy, m: mm, d: dd });
        if (out.length >= limit) return out;
      }
    } catch { /* 单日失败不影响 */ }
  }
  return out;
}

function fmtMonthDay(m, d) {
  return `${m}月${d}日`;
}

function joinList(arr, fallback = '无') {
  const items = uniq(arr).slice(0, MAX_ITEMS);
  return items.length ? items.join('、') : fallback;
}

/** 生成一张「今日日历」Markdown 文本 */
export function buildCalendarCard(now = new Date()) {
  const { y, m, d } = shanghaiToday(now);

  // 兜底：黄历库异常时至少给出公历 + 农历（Intl 支持中国历）
  if (!Solar) {
    let lunarText = '农历获取失败';
    try {
      lunarText = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai',
      }).format(now);
    } catch { /* ignore */ }
    return [
      '# 📅 今日日历',
      `**${y}年${m}月${d}日 · 星期${WEEK_CN[new Date(now).getDay()]}**`,
      `**农历**：${lunarText}`,
      '**宜**：日常、摸鱼',
      '**忌**：迷信、熬夜',
      '',
      '> 黄历数据暂时没加载出来，宜忌先用固定文案；仅供娱乐。',
    ].join('\n');
  }

  const solar = solarOf(y, m, d);
  const lunar = solar.getLunar();

  const week = `星期${WEEK_CN[solar.getWeek()] || ''}`;
  const zodiac = lunar.getYearShengXiao();
  const lunarText = `${lunar.getYearInGanZhi()}年（${zodiac}年）${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
  const ganzhi = `${lunar.getYearInGanZhi()}年 ${lunar.getMonthInGanZhi()}月 ${lunar.getDayInGanZhi()}日`;

  // 节日：公历 + 农历 + 其他（如寒食）
  const todayFestivals = uniq([
    ...(solar.getFestivals() || []),
    ...(lunar.getFestivals() || []),
    ...(lunar.getOtherFestivals() || []),
  ]);

  // 节气
  let jieqiLine = '';
  const todayJieQi = lunar.getJieQi ? lunar.getJieQi() : '';
  if (todayJieQi) {
    jieqiLine = `**节气**：今天是「${todayJieQi}」`;
  } else {
    try {
      const next = lunar.getNextJieQi(true);
      if (next) {
        const ns = next.getSolar();
        jieqiLine = `**节气**：下一个「${next.getName()}」${fmtMonthDay(ns.getMonth(), ns.getDay())}`;
      }
    } catch { /* ignore */ }
  }

  // 接下来（节气 + 节日，按日期排前 3 个不重复）
  const upcoming = [];
  try {
    const next = lunar.getNextJieQi(true);
    if (next) {
      const ns = next.getSolar();
      upcoming.push({ name: next.getName(), y: ns.getYear(), m: ns.getMonth(), d: ns.getDay(), kind: '节气' });
    }
  } catch { /* ignore */ }
  const nextFests = nextFestivals(y, m, d, 75, 4);
  for (const f of nextFests) upcoming.push({ ...f, kind: '节日' });
  upcoming.sort((a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d));
  const upcomingLines = [];
  const seen = new Set();
  for (const e of upcoming) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    upcomingLines.push(`${e.name}（${fmtMonthDay(e.m, e.d)}）`);
    if (upcomingLines.length >= 3) break;
  }

  const yi = joinList(lunar.getDayYi ? lunar.getDayYi() : []);
  const ji = joinList(lunar.getDayJi ? lunar.getDayJi() : []);
  const chong = `冲${lunar.getDayChongShengXiao()} · 煞${lunar.getDaySha()}`;
  const tianShen = `${lunar.getDayTianShen()}（${lunar.getDayTianShenType()}·${lunar.getDayTianShenLuck()}）`;
  const zhiXing = `${lunar.getZhiXing()}日`;
  const jiShen = joinList(lunar.getDayJiShen ? lunar.getDayJiShen() : []);
  const xiongSha = joinList(lunar.getDayXiongSha ? lunar.getDayXiongSha() : []);
  const naYin = lunar.getDayNaYin ? lunar.getDayNaYin() : '';
  const xingZuo = solar.getXingZuo ? solar.getXingZuo() : '';

  const lines = [
    '# 📅 今日日历',
    `**${y}年${m}月${d}日 · ${week}**`,
    '',
    `**农历**：${lunarText}`,
    `**干支**：${ganzhi}`,
  ];
  if (xingZuo) lines.push(`**星座**：${xingZuo}座`);
  lines.push(
    '',
    `**宜**：${yi}`,
    `**忌**：${ji}`,
    '',
    `**冲煞**：${chong}`,
    `**值神**：${tianShen} · **建除**：${zhiXing}`,
  );
  if (naYin) lines.push(`**纳音**：${naYin}`);
  lines.push(`**吉神**：${jiShen}`, `**凶煞**：${xiongSha}`);
  lines.push('');
  lines.push(`**节日**：${todayFestivals.length ? todayFestivals.join('、') : '今天没有特殊节日'}`);
  if (jieqiLine) lines.push(jieqiLine);
  if (upcomingLines.length) lines.push(`**接下来**：${upcomingLines.join('、')}`);
  lines.push('', '> 黄历宜忌仅供参考，别拿它决定大事喔');

  return lines.join('\n');
}

/**
 * 「/日历」对外的那几行（2026-11-09 从 commands/日历.mjs 下沉到这里）。
 *
 * 为什么要下沉：现在有**两个入口**要用这段文本 ——
 *   ① 斜杠命令 `/日历`；
 *   ② 各玩法卡片底部的「📅 日历」功能按钮（card-nav.mjs）。
 * 两处必须输出**逐字一致**的内容，否则主人从卡片点进来看到的和打命令看到的不一样。
 * 所以这里成为唯一真相源，命令那边只负责"发送"，不再自己拼格式。
 *
 * 主人给的格式（逐字对齐）：
 * ```
 * # 📅 日历
 *
 * **2026年11月9日 · 星期一**
 *
 * **农历**：丙午年（马年）十月初一
 * **干支**：丙午年 己亥月 丁亥日
 * **星座**：天蝎座
 *
 * **节日**：寒衣节
 * **节气**：下一个「小雪」11月22日
 * **接下来**：小雪（11月22日）、感恩节（11月26日）、平安夜（12月24日）
 * ```
 *
 * 与旧 `/今日如何` 的差异：不含运势/金句/宜忌/冲煞/值神/纳音/吉神/凶煞。
 */
export function buildCalendarText(now = new Date()) {
  let raw = '';
  try {
    raw = buildCalendarCard(now);
  } catch {
    return '# 📅 日历\n\n今天算不出来，稍后再试。';
  }

  const lines = String(raw ?? '').split('\n').map((l) => l.trim());
  const pick = (prefix) => lines.find((l) => l.startsWith(`**${prefix}**`)) ?? '';
  const dateLine = lines.find((l) => /^\*\*\d{4}年\d{1,2}月\d{1,2}日/.test(l)) ?? '';
  const lunar = pick('农历');
  const ganzhi = pick('干支');
  const zodiac = pick('星座');
  const festival = pick('节日');
  const jieqi = pick('节气');
  const upcoming = pick('接下来');

  const out = ['# 📅 日历', ''];
  if (dateLine) out.push(dateLine, '');
  if (lunar) out.push(lunar);
  if (ganzhi) out.push(ganzhi);
  if (zodiac) out.push(zodiac);
  // 节日/节气/接下来 是第二段，前面空一行（与主人样板一致）
  if (festival || jieqi || upcoming) {
    out.push('');
    if (festival) out.push(festival);
    if (jieqi) out.push(jieqi);
    if (upcoming) out.push(upcoming);
  }
  return out.join('\n');
}

/** 给工具/调试用：返回结构化数据（目前不需要，但方便以后扩展） */
export function getCalendarData(now = new Date()) {
  if (!Solar) return { available: false, ...shanghaiToday(now) };
  const { y, m, d } = shanghaiToday(now);
  const solar = solarOf(y, m, d);
  const lunar = solar.getLunar();
  return {
    available: true,
    y, m, d,
    week: WEEK_CN[solar.getWeek()],
    lunar: {
      yearGanZhi: lunar.getYearInGanZhi(),
      zodiac: lunar.getYearShengXiao(),
      month: lunar.getMonthInChinese(),
      day: lunar.getDayInChinese(),
    },
    festivals: uniq([...(solar.getFestivals() || []), ...(lunar.getFestivals() || [])]),
    yi: lunar.getDayYi ? lunar.getDayYi() : [],
    ji: lunar.getDayJi ? lunar.getDayJi() : [],
  };
}
