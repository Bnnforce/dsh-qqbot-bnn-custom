/** 群友生日：严格按当前群隔离；文件仍在 group-memory/<gid>/events/birthdays。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TZ = 'Asia/Shanghai';
export function dataRootOf(x) {
  return String(x?.dataRoot || x?.caps?.dataRoot || '').trim();
}
export function groupIdOf(x) {
  const caps = x?.caps ?? x ?? {};
  const scope = String(x?.peer?.scope || caps.scope || (x?.message?.kind === 'group' ? 'group' : 'c2c'));
  const gid = String(x?.peer?.peerId || caps.peerId || x?.message?.groupOpenid || '');
  return scope === 'group' && gid ? gid : '';
}
export function groupName(root, gid) {
  try {
    const j = JSON.parse(readFileSync(join(root, '.qqbot', 'groups.json'), 'utf8')) || {};
    return String(j[gid]?.name || '');
  } catch { return ''; }
}
export function birthdayDir(root, gid) {
  return join(root, '.qqbot-extensions', 'data', 'group-memory', 'groups', gid, 'events', 'birthdays');
}
export function today(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}
function addDays(ymd, n) {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + n, 12));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
export function parseBirthdayDate(input) {
  const s = String(input ?? '').trim().replace(/[，,]/g, ' ');
  const m = /^(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?\s*$/.exec(s);
  if (!m) return null;
  const mm = Number(m[1]), dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return { month: mm, day: dd, key: `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}` };
}
export function personOf(text, filename) {
  const m = /- 人物：([^\n]+)/.exec(text);
  return (m?.[1] || filename.replace(/^\d{2}-\d{2}-/, '').replace(/\.md$/i, '')).trim().replace(/[。.!！\s]+$/, '');
}
export function listBirthdays(root, gid) {
  const dir = birthdayDir(root, gid);
  const out = [];
  try {
    for (const filename of readdirSync(dir)) {
      if (!/\.md$/i.test(filename)) continue;
      const text = readFileSync(join(dir, filename), 'utf8');
      const b = /- 生日：每年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
      if (!b) continue;
      out.push({
        person: personOf(text, filename),
        month: Number(b[1]), day: Number(b[2]),
        filename,
        text,
      });
    }
  } catch { /* no dir */ }
  return out.sort((a, b) => (a.month - b.month) || (a.day - b.day) || a.person.localeCompare(b.person, 'zh'));
}
export function saveBirthday(root, gid, name, month, day, source = '主人手动添加') {
  const gname = groupName(root, gid);
  const key = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const safe = String(name).replace(/[\\/:*?"<>|\n]/g, '_').trim().slice(0, 40) || '群友';
  // 同名旧档先删，保证一人一档
  const dir = birthdayDir(root, gid);
  mkdirSync(dir, { recursive: true });
  for (const old of listBirthdays(root, gid)) {
    if (old.person === name) {
      try { unlinkSync(join(dir, old.filename)); } catch { /* ignore */ }
    }
  }
  const text = [
    `# 生日-${name}`,
    '',
    '## Current',
    `- 生日：每年 ${month} 月 ${day} 日。`,
    `- 人物：${name}。`,
    '- openid：未记录。',
    `- 群：${gname || gid}（${gid}）。`,
    `- 来源：${source}。`,
    '- 提醒：当天祝生日快乐。',
    '',
    '## History',
    '',
    '## Related',
    `- entities/groups/${gname || '本群'}.md`,
  ].join('\n');
  const file = join(dir, `${key}-${safe}.md`);
  const tmp = `${file}.tmp.${Date.now()}`;
  writeFileSync(tmp, text + '\n', 'utf8');
  renameSync(tmp, file);
  return { file, key };
}
export function removeBirthday(root, gid, name) {
  const dir = birthdayDir(root, gid);
  const hit = listBirthdays(root, gid).find((x) => x.person === name);
  if (!hit) return false;
  try { unlinkSync(join(dir, hit.filename)); return true; } catch { return false; }
}
export function renderQuery(root, gid, mode = 'week') {
  const list = listBirthdays(root, gid);
  const t = today();
  const name = groupName(root, gid) || '本群';
  const lines = [`🎂 群友生日（${name}）`, ''];
  if (mode === 'all') {
    if (!list.length) return `${lines.join('\n')}\n本群还没有生日档。可以发：/群友生日查询 加 3月15日 登记自己的生日`;
    lines.push(`共 ${list.length} 条：`);
    list.forEach((x, i) => lines.push(`${i + 1}. ${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')} ${x.person}`));
    return lines.join('\n');
  }
  const todays = list.filter((x) => x.month === t.m && x.day === t.d);
  lines.push(todays.length ? `今天：${todays.map((x) => x.person).join('、')}` : '今天：本群没有人生日。');
  lines.push('', '未来 7 天：');
  let n = 0;
  for (let i = 1; i <= 7; i++) {
    const d = addDays(t, i);
    const hits = list.filter((x) => x.month === d.m && x.day === d.d);
    if (hits.length) { lines.push(`${n + 1}. ${d.m}月${d.d}日 ${hits.map((x) => x.person).join('、')}`); n++; }
  }
  if (!n) lines.push('未来 7 天没有生日。');
  if (!list.length) lines.push('', '本群还没有生日档。可以发：/群友生日查询 加 3月15日 登记自己的生日');
  return lines.join('\n');
}
export function isOwner(x) {
  return x?.caps?.user?.isOwner === true || x?.user?.isOwner === true || x?.isOwner === true;
}
