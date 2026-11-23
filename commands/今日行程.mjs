/**
 * /今日行程
 * 一人一表，按 openid 隔离；默认只看自己。
 */
import {
  dataRootOf, loadPerson, savePerson, addPending, pushHistory,
  parseTime, formatPending, localStamp, daysWindow, makeId,
} from '../lib/itinerary.mjs';

const HELP = [
  '可以这样用：',
  '/今日行程 我的行程    看自己接下来的安排',
  '/今日行程 行程历史    看已经提醒过的记录',
  '/今日行程 今天        看今天',
  '/今日行程 明天        看明天',
  '/今日行程 过两分钟 开会    新增行程',
  '/今日行程 明天早上九点 开会    新增行程',
  '/今日行程 删除 1      删除最近列表里的第 1 条',
].join('\n');

function ctxInfo(ctx) {
  const caps = ctx?.caps ?? ctx ?? {};
  const root = dataRootOf(ctx);
  const scope = String(caps.scope || ctx?.peer?.scope || (ctx?.message?.kind === 'group' ? 'group' : 'c2c'));
  const peerId = String(caps.peerId || ctx?.peer?.peerId || caps.peer?.peerId || '');
  const openid = String(caps.actorOpenid || caps.user?.openid || ctx?.user?.openid || ctx?.senderOpenid || '');
  const name = String(ctx?.senderName ?? ctx?.message?.senderName ?? caps.user?.name ?? '群友');
  const target = scope === 'group' ? peerId : (peerId || openid);
  return { root, scope, peerId, openid, name, target, isOwner: caps.user?.isOwner === true || ctx?.user?.isOwner === true };
}
function parseArgs(raw) {
  return String(raw ?? '').trim();
}
function rememberView(person, list) {
  person.lastView = { at: Date.now(), ids: list.map((x) => String(x.id)) };
}
function withDeleteHint(text, list) {
  return list.length ? `${text}\n\n删除：/今日行程 删除 序号` : text;
}

function historyText(person, n = 10) {
  const rows = person.history.slice(-Math.max(1, Math.min(100, n))).reverse();
  if (!rows.length) return '还没有已触发的行程记录。';
  const mark = { sent: '✅', missed: '⏰', failed: '⚠️' };
  return [`🕘 最近 ${rows.length} 条历史（只看你自己）`]
    .concat(rows.map((r, i) => `${i + 1}. ${mark[r.result] || '·'} ${localStamp(r.fireAt)} ${r.text}`))
    .join('\n');
}
export default {
  name: ['今日行程', '行程'],
  description: '查看/添加/删除个人行程；到点提醒；一人一表，不串人',
  usage: '/今日行程 我的行程 | /今日行程 行程历史 | /今日行程 过两分钟 开会 | /今日行程 删除 序号',
  async handler(ctx) {
    const info = ctxInfo(ctx);
    if (!info.root) return '拿不到数据根，暂时用不了行程。';
    if (!info.openid) return '拿不到你的身份，稍后再试。';
    const person = loadPerson(info.root, info.openid);
    const raw = parseArgs(ctx?.command?.raw ?? ctx?.rawArgs ?? '');
    const a = raw.trim();

    if (!a) return HELP;

    if (a === '我的行程' || a === '我的安排') {
      const list = person.pending.slice().sort((x, y) => Number(x.fireAt) - Number(y.fireAt));
      rememberView(person, list);
      savePerson(info.root, person);
      return withDeleteHint(formatPending(list, '我的行程'), list) + (list.length ? '' : '\n\n还没有行程。直接说「过两分钟 喝水」就行。');
    }

    if (a === '明天' || a === '今天' || a === '本周' || a === '全部') {
      let list = person.pending;
      if (a === '今天') { const [s, e] = daysWindow(new Date(), 'today'); list = list.filter((x) => x.fireAt >= s && x.fireAt < e); }
      if (a === '明天') { const [s, e] = daysWindow(new Date(), 'tomorrow'); list = list.filter((x) => x.fireAt >= s && x.fireAt < e); }
      if (a === '本周') { const [s, e] = daysWindow(new Date(), 'week'); list = list.filter((x) => x.fireAt >= s && x.fireAt < e); }
      rememberView(person, list);
      savePerson(info.root, person);
      return withDeleteHint(formatPending(list, a === '全部' ? '全部行程' : a + '行程'), list);
    }

    if (a === '行程历史' || a === '历史') return historyText(person, 10);
    let m = /^行程历史\s+(\d+)\s*$/.exec(a) || /^历史\s+(\d+)\s*$/.exec(a);
    if (m) return historyText(person, Number(m[1]));

    m = /^删除\s+(.+)$/.exec(a) || /^删\s+(.+)$/.exec(a);
    if (m) {
      const prefix = m[1].trim();
      let hit = null;
      if (/^\d+$/.test(prefix)) {
        const lv = person.lastView;
        const n = Number(prefix) - 1;
        if (lv && Date.now() - Number(lv.at || 0) < 3600_000 && Array.isArray(lv.ids) && n >= 0 && n < lv.ids.length) {
          hit = person.pending.find((x) => String(x.id) === lv.ids[n]) || null;
        }
        if (!hit) return '序号无效，先发 /今日行程 看当前列表再删。';
      } else {
        hit = person.pending.find((x) => String(x.id) === prefix) || person.pending.find((x) => String(x.id).startsWith(prefix));
      }
      if (!hit) return `没找到这条行程：${prefix}`;
      person.pending = person.pending.filter((x) => x !== hit);
      savePerson(info.root, person);
      return `已删除：${hit.text}（${localStamp(hit.fireAt)}）`;
    }

    // 添加行程：不再要求「加」前缀
    // /今日行程 今天晚上九点 开会
    // /今日行程 过两分钟 开会
    // /今日行程 过三天 生日
    let text = a.replace(/^加\s*/, '').trim();
    let repeat = 'once';
    if (/^每天\s+/.test(text)) { repeat = 'daily'; text = text.replace(/^每天\s+/, ''); }
    else if (/^每个?工作日\s+/.test(text)) { repeat = 'weekday'; text = text.replace(/^每个?工作日\s+/, ''); }
    else if (/每天\s*$/.test(text)) { repeat = 'daily'; text = text.replace(/\s*每天\s*$/, ''); }
    const parsed = parseTime(text);
    if (!parsed.ok) return `${parsed.msg || '没看懂时间。'}\n可以这样说：「今天晚上九点 开会」「过两分钟 开会」「过三天 生日」「明天早上九点十分 开会」。`;
    const eventText = String(parsed.rest || '').replace(/^[-—:：\s]+/, '').trim();
    if (!eventText) return '时间听懂了，但还没说要做什么。例如：/今日行程 过两分钟 喝水';
    const item = {
      id: makeId(), owner: info.openid, ownerName: info.name,
      scope: info.scope, target: info.target,
      fireAt: parsed.fireAt, timeText: parsed.label,
      text: eventText, repeat, createdAt: Date.now(), status: 'pending',
    };
    const r = addPending(person, item);
    if (!r.ok) return r.msg;
    savePerson(info.root, person);
    return `✅ 记下了：${parsed.label} ${eventText}${repeat === 'once' ? '' : repeat === 'daily' ? '（每天）' : '（工作日）'}\n编号：${item.id.slice(0, 6)}`;

    return HELP;
  },
};
