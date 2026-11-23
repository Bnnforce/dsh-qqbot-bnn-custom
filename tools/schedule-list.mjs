/** 查询个人行程/历史（工具） */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataRootOf, loadPerson, formatPending, localStamp, daysWindow,
} from '../lib/itinerary.mjs';

function infoOf(env) {
  const caps = env?.caps ?? env ?? {};
  const root = dataRootOf(env);
  const scope = String(env?.peer?.scope ?? caps.scope ?? 'c2c');
  const peerId = String(env?.peer?.peerId || env?.peerId || env?.caps?.peerId || '');
  const openid = String(env?.user?.openid ?? caps.actorOpenid ?? '');
  return { root, scope, peerId, openid, isOwner: env?.user?.isOwner === true || (Array.isArray(env?.owners) && env.owners.includes(openid)) };
}
function resolveWho(root, who) {
  const s = String(who ?? '').trim();
  if (!s) return { error: 'who 为空' };
  if (/^[A-Za-z0-9_-]{16,}$/.test(s)) return { openid: s, name: '' };
  try {
    const raw = readFileSync(join(root, '表情包', 'group-members.jsonl'), 'utf8');
    const map = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d?.mid && d?.name && String(d.name).includes(s)) map.set(String(d.mid), String(d.name));
      } catch { /* skip */ }
    }
    if (map.size === 1) return { openid: [...map.keys()][0], name: [...map.values()][0] };
    if (map.size > 1) return { error: '昵称匹配到多个人，请给完整 openid：' + [...map.values()].slice(0, 6).join('、') };
  } catch { /* ignore */ }
  return { error: '没找到这个人：' + s };
}
export default {
  name: 'schedule_list',
  expose: 'qq',
  description: '查询个人行程或历史。range=today/week/history/all；默认只查自己，主人可用 who 查他人（openid 或昵称）。一人一表，不能跨人串看。',
  inputSchema: {
    range: { type: 'string', description: 'today / week / history / all，默认 today' },
    who: { type: 'string', description: '可选，仅主人：要查的人的 openid 或昵称；不填=自己' },
    limit: { type: 'integer', description: 'history 最多几条，默认 10，上限 100' },
  },
  async run(args = {}, env = {}) {
    const info = infoOf(env);
    if (!info.root || !info.openid) return { ok: false, msg: '拿不到当前用户/数据根' };
    let owner = info.openid, ownerName = '';
    if (args.who) {
      if (!info.isOwner) return { ok: false, msg: '你还没有该权限哦' };
      const r = resolveWho(info.root, args.who);
      if (r.error) return { ok: false, msg: r.error };
      owner = r.openid; ownerName = r.name;
    }
    const person = loadPerson(info.root, owner);
    const range = String(args.range || 'today');
    if (range === 'history') {
      const n = Math.max(1, Math.min(100, Number(args.limit) > 0 ? Number(args.limit) : 10));
      const rows = person.history.slice(-n).reverse();
      if (!rows.length) return { ok: true, msg: `${ownerName || '当前用户'}还没有历史行程。`, data: [] };
      const lines = [`🕘 ${ownerName || '当前用户'}最近 ${rows.length} 条历史`];
      for (const r of rows) lines.push(`· ${localStamp(r.fireAt)} ${r.text} [${r.result}]`);
      return { ok: true, msg: lines.join('\n'), data: rows };
    }
    let list = person.pending;
    if (range === 'today' || range === 'week') {
      const [s, e] = daysWindow(new Date(), range);
      list = list.filter((x) => x.fireAt >= s && x.fireAt < e);
    }
    return { ok: true, msg: formatPending(list, ownerName ? `${ownerName}的行程` : '行程'), data: list };
  },
};
