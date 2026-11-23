/**
 * group_members — 按群查询本地群成员名单（只读）
 *
 * 数据源：{dataRoot}/表情包/group-members.jsonl（插件中间件记录：说过话/申请入群的人）
 * 群名源：{dataRoot}/.qqbot/groups.json
 *
 * 默认只查“当前群”；群里所有人可查本群。查别的群需要主人权限（按群隔离，不混名单）。
 * 问“这是谁/谁是谁/群里有谁”时调用本工具；不要凭印象编名单。
 */
import { isOwnerEnv } from './lib/owner.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function dataRootOf(env) {
  return String(env?.dataRoot || env?.caps?.dataRoot || '').trim();
}
function currentGid(env) {
  const scope = String(env?.peer?.scope ?? env?.peerScope ?? '');
  const id = String(env?.peer?.peerId ?? env?.peerId ?? env?.groupId ?? '').trim();
  return scope === 'group' && id ? id : '';
}
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function loadGroups(root) {
  const j = readJson(join(root, '.qqbot', 'groups.json'));
  return j && typeof j === 'object' ? j : {};
}
function loadMembers(root, gid) {
  const map = new Map();
  try {
    const raw = readFileSync(join(root, '表情包', 'group-members.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (String(e?.gid ?? '') !== gid) continue;
        const mid = String(e?.mid ?? '').trim();
        if (!mid) continue;
        const cur = map.get(mid) || { mid, name: '', ts: 0, count: 0 };
        const ts = Number(e?.ts ?? 0);
        if (ts >= cur.ts) { cur.ts = ts; cur.name = String(e?.name ?? '').trim() || cur.name; }
        cur.count += 1;
        map.set(mid, cur);
      } catch { /* skip bad line */ }
    }
  } catch { /* no ledger */ }
  return [...map.values()].sort((a, b) => b.ts - a.ts);
}
function fmtTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function resolveGroup(args, env, groups) {
  const root = dataRootOf(env);
  const cur = currentGid(env);
  const rawGid = String(args?.gid ?? '').trim();
  const rawGroup = String(args?.group ?? '').trim();
  if (rawGid) return { gid: rawGid, name: String(groups?.[rawGid]?.name ?? '') };
  if (rawGroup) {
    const exact = Object.entries(groups).filter(([, v]) => String(v?.name ?? '') === rawGroup);
    const like = exact.length ? exact : Object.entries(groups).filter(([, v]) => String(v?.name ?? '').includes(rawGroup));
    if (like.length === 1) return { gid: like[0][0], name: String(like[0][1]?.name ?? '') };
    if (like.length > 1) return { error: '群名匹配到多个，请指定更完整的群名或 gid：' + like.map(([g, v]) => `${v?.name ?? ''}(${g})`).join('、') };
    if (/^[A-Fa-f0-9]{32}$/.test(rawGroup)) return { gid: rawGroup, name: String(groups?.[rawGroup]?.name ?? '') };
    return { error: '没找到这个群：' + rawGroup };
  }
  if (!cur) return { error: '当前不是群聊，请用 group 或 gid 指定群' };
  return { gid: cur, name: String(groups?.[cur]?.name ?? '') };
}

export default {
  name: 'group_members',
  expose: 'qq',
  description: '查询某个 QQ 群的本地成员名单（只含说过话/申请入群的人，按最近发言排序）。问“这是谁/谁是谁/群里有谁”时调用；默认查当前群，查别的群需要主人权限。不要凭记忆编名单。',
  inputSchema: {
    group: { type: 'string', description: '可选：群名或群 openid；不填=当前群' },
    gid: { type: 'string', description: '可选：群 openid（精确）' },
    query: { type: 'string', description: '可选：按昵称或 openid 片段搜索' },
    limit: { type: 'integer', description: '可选：最多列几个，默认 30，上限 100' },
  },
  async run(args = {}, env = {}) {
    const root = dataRootOf(env);
    if (!root) return { ok: false, msg: '拿不到数据根（env.dataRoot 为空）' };
    const groups = loadGroups(root);
    const target = resolveGroup(args, env, groups);
    if (target.error) return { ok: false, msg: target.error };
    const cur = currentGid(env);
    const isOwner = isOwnerEnv(env);
    if (target.gid !== cur && !isOwner) return { ok: false, msg: '查别的群名单需要主人权限；本群名单可以直接查。' };

    const members = loadMembers(root, target.gid);
    if (!members.length) return { ok: true, msg: `群 ${target.name || target.gid} 还没有成员台账（没人说过话）。`, data: { gid: target.gid, name: target.name, members: [] } };
    const q = String(args?.query ?? '').trim().toLowerCase();
    let picked = q ? members.filter((m) => m.name.toLowerCase().includes(q) || m.mid.toLowerCase().includes(q)) : members;
    const limit = Math.max(1, Math.min(100, Number(args?.limit) > 0 ? Math.floor(Number(args.limit)) : 30));
    const total = picked.length;
    picked = picked.slice(0, limit);
    const head = `群「${target.name || target.gid}」成员（本地台账，按最近发言；显示 ${picked.length}/${total} 人${q ? `，搜索“${args.query}”` : ''}）：`;
    const lines = picked.map((m) => `- ${m.name || '（未记录昵称）'}（openid: ${m.mid}，最近: ${fmtTime(m.ts) || '未知'}，记录: ${m.count} 条）`);
    const msg = [head, ...lines].join('\n') + '\n注：台账只包含在群里说过话/申请过入群的人，不是完整群名单。';
    return { ok: true, msg, data: { gid: target.gid, name: target.name, total, members: picked } };
  },
};
