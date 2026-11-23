#!/usr/bin/env node
/**
 * QQ 机器人周报生成器（dsh-qqbot 台账 → Markdown / QQ 摘要 / Excel）
 *
 * 用法:
 *   node weekly-report.mjs                    # 周一跑=上周完整周；其它日子跑=本周至今
 *   node weekly-report.mjs --out=/path/dir    # 输出目录（默认 {dataRoot}/../周报）
 *   node weekly-report.mjs --dataRoot=/path   # 插件数据根（默认由本文件位置推导）
 *   node weekly-report.mjs --ns=im-qqbot-2    # 设置命名空间（读熟识度/好感度档位用）
 *
 * 数据源: {dataRoot}/.qqbot/{affinity,attitude,intimacy-daily}.json
 *         + value-scores.jsonl / four-source.jsonl（观察台账）
 * 输出:   QQBot周报-<日期>.md、同名-qq.txt（发 QQ 的短版）、熟识度好感度_<日期>.xlsx、history.json（环比快照）
 *
 * ★ 2026-11-20 迁入扩展包：本文件原在 {workspace}/Bot/scripts/，是 `inbound/weekly-report.mjs`
 *   的**运行时依赖**。留在扩展包外 ⇒ 整包分发自包含性被破坏（换机只拷 extension-packs 就跑不了）。
 *   现位置 `{dataRoot}/extension-packs/bnn-custom/lib/scripts/`，默认路径全部由自身位置推导，
 *   不再依赖任何绝对路径（开源/换机安全）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, def) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def;
}

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
// SELF_DIR = {dataRoot}/extension-packs/<pack>/lib/scripts  ⇒ 上 4 级 = {dataRoot}
const DERIVED_DATA_ROOT = path.resolve(SELF_DIR, '..', '..', '..', '..');
const DATA_ROOT = arg('dataRoot', process.env.QQBOT_DATA_ROOT || DERIVED_DATA_ROOT);
// {dataRoot}/.. = {workspace}/Bot，周报落在 Bot/周报
const OUT_DIR = arg('out', process.env.QQBOT_REPORT_DIR || path.resolve(DATA_ROOT, '..', '周报'));
const NS = arg('ns', process.env.QQBOT_NS || 'im-qqbot-2');
const API = arg('api', process.env.DSH_WEB_URL || process.env.DSH_WEB || 'http://127.0.0.1:4145').replace(/\/+$/, '');
const QDIR = path.join(DATA_ROOT, '.qqbot');
const DAY = 86400000;

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readJsonl = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
};
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const md = (d) => `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const fix = (n, k = 0) => Number(n || 0).toFixed(k);

// ── 周期：周一跑=上周完整周（周一~周日）；其它日子跑=本周至今 ──
const now = new Date();
function mondayOf(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const diff = (x.getDay() + 6) % 7; x.setDate(x.getDate() - diff); return x;
}
let start, end;
if (now.getDay() === 1) { end = mondayOf(now); start = new Date(end.getTime() - 7 * DAY); }
else { start = mondayOf(now); end = now; }
const periodLabel = now.getDay() === 1 ? '上周（周一~周日）' : '本周至今';
const inP = (ts) => typeof ts === 'number' && ts >= start.getTime() && ts < end.getTime();

// ── 原始台账 ──
const affinity = (readJson(path.join(QDIR, 'affinity.json'), { map: {} }).map) || {};
const attitude = (readJson(path.join(QDIR, 'attitude.json'), { map: {} }).map) || {};
const daily = (readJson(path.join(QDIR, 'intimacy-daily.json'), { days: {} }).days) || {};
const groups = readJson(path.join(QDIR, 'groups.json'), {}) || {};
const four = readJsonl(path.join(QDIR, 'four-source.jsonl')).filter((e) => inP(e.ts));
const scores = readJsonl(path.join(QDIR, 'value-scores.jsonl')).filter((e) => inP(e.ts));

// ── 每日台账（群聊）：本周消息 / 人数 / 群活跃 ──
const startKey = ymd(start);
const endKey = ymd(new Date(end.getTime() - 1));
const dayKeys = Object.keys(daily).filter((k) => k >= startKey && k <= endKey).sort();
const persons = new Map();
const groupAgg = new Map();
for (const k of dayKeys) {
  for (const [ck, v] of Object.entries(daily[k] || {})) {
    const [chat, openid] = ck.split('|');
    const gid = chat.startsWith('group:') ? chat.slice(6) : '';
    const P = persons.get(openid) || { openid, name: v.name || openid, msgs: 0, mentions: 0, imgs: 0, days: new Set() };
    P.msgs += v.msgs || 0; P.mentions += v.mentions || 0; P.imgs += v.imgs || 0; P.days.add(k);
    if (v.name) P.name = v.name;
    persons.set(openid, P);
    if (gid) {
      const G = groupAgg.get(gid) || { gid, msgs: 0, imgs: 0, people: new Set() };
      G.msgs += v.msgs || 0; G.imgs += v.imgs || 0; G.people.add(openid);
      groupAgg.set(gid, G);
    }
  }
}
const groupMsgs = [...groupAgg.values()].reduce((s, g) => s + g.msgs, 0);

// ── 回合（four-source）：醒了几次 / 开口几次 ──
const turns = new Map();
for (const e of four) {
  const key = `${e.scope}:${e.peer}:${e.turn}`;
  const t = turns.get(key) || { scope: e.scope, peer: e.peer, turn: e.turn, reply: 0, think: 0, steps: 0 };
  t.steps++; t.think += e.thinkChars || 0; t.reply = Math.max(t.reply, e.replyChars || 0);
  turns.set(key, t);
}
const turnList = [...turns.values()];
const spokeTurns = turnList.filter((t) => t.reply > 0);
const groupTurns = turnList.filter((t) => t.scope === 'group');
const c2cTurns = turnList.filter((t) => t.scope === 'c2c');
const replyChunks = four.filter((e) => (e.replyChars || 0) > 0).length;

// ── 价值评分 ──
const scored = scores.filter((e) => typeof e.score === 'number');
const avgScore = scored.length ? scored.reduce((s, e) => s + e.score, 0) / scored.length : null;
const worthCount = scored.filter((e) => e.worth === true).length;
const silenced = scores.filter((e) => e.gate === 'block' && e.worth === false).length;
const gateCount = scores.reduce((m, e) => { const g = e.gate || '?'; m[g] = (m[g] || 0) + 1; return m; }, {});

// ── 档位（面板 API 优先；拿不到就用文件里的原始值）──
async function apiJson(p) {
  try {
    const r = await fetch(`${API}${p}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
const affApi = await apiJson(`/api/qqbot-settings/affinity?ns=${encodeURIComponent(NS)}&limit=50`);
const attApi = await apiJson(`/api/qqbot-settings/attitude?ns=${encodeURIComponent(NS)}&all=1`);
const affItems = new Map(((affApi && affApi.items) || []).map((x) => [x.key, x]));
const attItems = new Map(((attApi && attApi.items) || []).map((x) => [x.key, x]));

const allKeys = [...new Set([...Object.keys(affinity), ...Object.keys(attitude)])];
const people = allKeys.map((key) => {
  const openid = key.replace(/^person:/, '');
  const aff = affinity[key] || {};
  const att = attitude[key] || {};
  const aApi = affItems.get(key) || {};
  const tApi = attItems.get(key) || {};
  return {
    openid, name: aApi.name || tApi.name || aff.name || att.name || openid.slice(0, 8),
    affScore: typeof aApi.score === 'number' ? aApi.score : null,
    affTier: aApi.tier || '',
    msgsAll: aff.msgs || 0, mentionsAll: aff.mentions || 0, repliesAll: aff.replies || 0,
    a: typeof tApi.a === 'number' ? tApi.a : (typeof att.a === 'number' ? att.a : 0),
    aTier: tApi.tier || '', aEvents: att.events || tApi.events || 0,
    why: tApi.why || att.lastWhy || '',
    lastAt: Math.max(aff.lastAt || 0, att.lastAt || 0),
  };
});
const weekMsgsOf = (openid) => (persons.get(openid) || {}).msgs || 0;

// ── 环比快照（上一期 → 本期增量）──
fs.mkdirSync(OUT_DIR, { recursive: true });
const historyPath = path.join(OUT_DIR, 'history.json');
const history = readJson(historyPath, { snapshots: [] });
const prev = (history.snapshots || [])[history.snapshots.length - 1] || null;
const prevAff = (prev && prev.affinity) || null;
const prevAtt = (prev && prev.attitude) || null;
const deltaAff = (openid) => {
  if (!prevAff) return null;
  const cur = ((affinity[`person:${openid}`] || {}).msgs) || 0;
  return cur - ((prevAff[openid] || {}).msgs || 0);
};
const deltaA = (openid) => {
  if (!prevAtt) return null;
  const cur = ((attitude[`person:${openid}`] || {}).a) || 0;
  const old = +(((prevAtt[openid] || {}).a) || 0);
  return Math.round((cur - old) * 1000) / 1000;
};

// ── 排序 ──
const byAff = [...people].filter((p) => p.msgsAll > 0 || p.affScore != null)
  .sort((x, y) => (y.affScore ?? -1) - (x.affScore ?? -1) || y.msgsAll - x.msgsAll).slice(0, 6);
const byAtt = [...people].sort((x, y) => Math.abs(y.a) - Math.abs(x.a) || y.aEvents - x.aEvents).slice(0, 6);
const byWeek = [...persons.values()].sort((x, y) => y.msgs - x.msgs).slice(0, 6);
const byGroup = [...groupAgg.values()].sort((x, y) => y.msgs - x.msgs);
const gname = (gid) => (groups[gid] && groups[gid].name) || `群 ${gid.slice(0, 6)}…`;

// ── Markdown ──
const stamp = ymd(now);
const L = [];
L.push(`# 🤖 Bnnbot 周报 · ${md(start)} ~ ${md(now)}`);
L.push('');
L.push(`> 周期：**${periodLabel}**（${startKey} 00:00 → ${stamp}）｜生成：${stamp} ${p2(now.getHours())}:${p2(now.getMinutes())}｜实例：\`${NS}\``);
L.push('');
L.push('## 一、本周概览');
L.push('');
L.push('| 指标 | 数值 |');
L.push('|---|---|');
L.push(`| 群里听到的消息 | **${groupMsgs}** 条（${byGroup.length} 个活跃群） |`);
L.push(`| 听过话的人 | **${persons.size}** 位 |`);
L.push(`| 她被唤醒的回合 | **${turnList.length}** 次（群 ${groupTurns.length} / 私聊 ${c2cTurns.length}） |`);
L.push(`| 其中开口回复 | **${spokeTurns.length}** 次（${pct(spokeTurns.length, turnList.length)}%），共发出 ${replyChunks} 条消息 |`);
L.push(`| 被价值门槛静默 | ${silenced} 条（block 模式；消息仍进上下文） |`);
L.push(`| 价值评分 | 覆盖 ${scored.length}/${scores.length} 条，均分 ${avgScore == null ? '—' : fix(avgScore, 3)}，达标 ${worthCount} 条（${pct(worthCount, scored.length)}%） |`);
L.push('');
L.push('## 二、熟识度榜（她把你记得多牢 · 累计）');
L.push('');
L.push('| # | 人 | 熟识度 | 档位 | 累计消息 | 本周 | 被点名 |');
L.push('|---|---|---|---|---|---|---|');
byAff.forEach((p, i) => {
  const d = deltaAff(p.openid);
  L.push(`| ${i + 1} | ${p.name} | ${p.affScore ?? '—'} | ${p.affTier || '—'} | ${p.msgsAll} | ${weekMsgsOf(p.openid)}${d == null ? '' : `（${d >= 0 ? '+' : ''}${d}）`} | ${p.mentionsAll} |`);
});
if (!byAff.length) L.push('| — | 本周还没有记录 | — | — | — | — | — |');
L.push('');
L.push('## 三、好感度榜（她对你什么态度 · 累计）');
L.push('');
L.push('| # | 人 | A 值 | 档位 | 事件数 | 本期变化 | 最近一条原因 |');
L.push('|---|---|---|---|---|---|---|');
byAtt.forEach((p, i) => {
  const d = deltaA(p.openid);
  L.push(`| ${i + 1} | ${p.name} | ${p.a >= 0 ? '+' : ''}${fix(p.a, 3)} | ${p.aTier || '—'} | ${p.aEvents} | ${d == null ? '—（首期）' : `${d >= 0 ? '+' : ''}${fix(d, 3)}`} | ${p.why || '—'} |`);
});
if (!byAtt.length) L.push('| — | 还没有好感事件 | — | — | — | — | — |');
L.push('');
L.push('## 四、本周谁在聊');
L.push('');
L.push('| # | 人 | 本周消息 | 被点名 | 图片 | 出现天数 |');
L.push('|---|---|---|---|---|---|');
byWeek.forEach((p, i) => L.push(`| ${i + 1} | ${p.name} | ${p.msgs} | ${p.mentions} | ${p.imgs} | ${p.days.size} 天 |`));
if (!byWeek.length) L.push('| — | 本周群里没人说话 | — | — | — | — |');
L.push('');
L.push('## 五、群活跃');
L.push('');
L.push('| 群 | 本周消息 | 发言人数 |');
L.push('|---|---|---|');
byGroup.forEach((g, i) => L.push(`| ${i + 1}. ${gname(g.gid)} | ${g.msgs} | ${g.people.size} |`));
if (!byGroup.length) L.push('| — | 本周没有群消息 | — |');
L.push('');
L.push('## 六、开口与门槛');
L.push('');
L.push(`- 价值评分分布：${Object.entries(gateCount).map(([g, n]) => `${g} ${n} 条`).join('、') || '无'}。`);
if (avgScore != null) L.push(`- 平均价值分 **${fix(avgScore, 3)}**（门槛 0.5）；理论上低于门槛的非 @ 消息会静默，本周实际静默 **${silenced}** 条。`);
L.push(`- 开口率 **${pct(spokeTurns.length, turnList.length)}%**（醒着的回合里真的出声的比例）。`);
L.push('');
L.push('## 七、观察与建议');
L.push('');
const tips = [];
if (!prev) tips.push('- 这是**首期**周报，已写入环比快照；从下一期开始会带「较上期 +N」。');
if (avgScore != null && avgScore < 0.45) tips.push(`- 平均价值分偏低（${fix(avgScore, 3)}），block 模式下会偏安静；想让群聊更活跃可把门槛降到 0.45，或往样例库补几条「该接的话」。`);
if (avgScore != null && avgScore > 0.7) tips.push(`- 平均价值分偏高（${fix(avgScore, 3)}），门槛还有收紧空间（提到 0.55~0.6 会更挑话）。`);
const closeTier = byAtt.filter((p) => !/亲近|冷淡|疏远/.test(p.aTier) && Math.abs(p.a) > 0.05);
if (closeTier.length) tips.push(`- 好感度接近换档：${closeTier.map((p) => `${p.name}（${p.a >= 0 ? '+' : ''}${fix(p.a, 3)}）`).join('、')}，再多几次互动就会变档。`);
const silentChats = new Set(scores.filter((e) => e.gate === 'block' && e.worth === false).map((e) => e.gid));
if (silentChats.size) tips.push(`- 被静默的会话：${[...silentChats].map((g) => (g === 'c2c' ? '私聊' : gname(g))).join('、')}（若私聊被静默，说明该会话没走豁免，检查 localModel.overrides）。`);
if (!tips.length) tips.push('- 本周无明显异常，保持现状即可。');
L.push(...tips);
L.push('');
L.push('## 附件');
L.push('');
L.push(`- 本报告：\`${path.join(OUT_DIR, `QQBot周报-${stamp}.md`)}\``);
L.push(`- 台账 Excel：\`${path.join(OUT_DIR, `熟识度好感度_${stamp}.xlsx`)}\`（面板同款：总览 / 熟识度 / 好感度 / 说明）`);
L.push('');

// ── QQ 短版 ──
const topAff = byAff[0];
const topAtt = byAtt.slice().sort((x, y) => Math.abs(y.a) - Math.abs(x.a))[0];
const qq = [
  `【Bnnbot 周报】${md(start)}~${md(now)}（${periodLabel}）`,
  `群里听到 ${groupMsgs} 条 / ${byGroup.length} 个群 / ${persons.size} 位；我醒了 ${turnList.length} 回合，开口 ${spokeTurns.length} 次（${pct(spokeTurns.length, turnList.length)}%）。`,
  topAff ? `最熟：${topAff.name} ${topAff.affScore ?? ''}（${topAff.affTier || '—'}）` : '',
  topAtt ? `好感：${topAtt.name} ${topAtt.a >= 0 ? '+' : ''}${fix(topAtt.a, 3)}（${topAtt.aTier || '—'}）` : '',
  silenced ? `被门槛静默 ${silenced} 条。` : '',
  `完整版：${path.join(OUT_DIR, `QQBot周报-${stamp}.md`)}`,
].filter(Boolean).join('\n');

const mdPath = path.join(OUT_DIR, `QQBot周报-${stamp}.md`);
const txtPath = path.join(OUT_DIR, `QQBot周报-${stamp}-qq.txt`);
fs.writeFileSync(mdPath, L.join('\n'), 'utf8');
fs.writeFileSync(txtPath, qq, 'utf8');

// ── Excel（面板同款导出；DSH 没在跑就跳过）──
let xlsxPath = '';
try {
  const r = await fetch(`${API}/api/qqbot-settings/export.xlsx?ns=${encodeURIComponent(NS)}`);
  if (r.ok) {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 1000) {
      xlsxPath = path.join(OUT_DIR, `熟识度好感度_${stamp}.xlsx`);
      fs.writeFileSync(xlsxPath, buf);
    }
  }
} catch { /* 跳过 */ }

// ── 快照（供下期环比）──
const snap = {
  at: Date.now(), weekStart: startKey, weekEnd: endKey,
  affinity: Object.fromEntries(Object.keys(affinity).map((k) => [k.replace(/^person:/, ''), { msgs: affinity[k].msgs || 0, mentions: affinity[k].mentions || 0 }])),
  attitude: Object.fromEntries(Object.keys(attitude).map((k) => [k.replace(/^person:/, ''), { a: attitude[k].a || 0, events: attitude[k].events || 0 }])),
};
history.snapshots = [...(history.snapshots || []), snap].slice(-12);
// history.json 是状态（下次要读回来算环比）→ 原子写
const _tmp = historyPath + `.${process.pid}.tmp`;
fs.writeFileSync(_tmp, JSON.stringify(history, null, 1), 'utf8');
fs.renameSync(_tmp, historyPath);

// ── 给调度器/人看的机器可读结果 ──
console.log(JSON.stringify({ ok: true, period: { start: startKey, end: endKey, label: periodLabel }, md: mdPath, txt: txtPath, xlsx: xlsxPath || null, stats: { groupMsgs, people: persons.size, groups: byGroup.length, turns: turnList.length, spoken: spokeTurns.length, replyChunks, scored: scored.length, avgScore, worth: worthCount, silenced } }, null, 1));
