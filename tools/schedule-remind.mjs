/** 设置个人行程提醒（工具） */
import { dataRootOf, loadPerson, savePerson, addPending, parseTime, makeId } from '../lib/itinerary.mjs';

function infoOf(env) {
  const caps = env?.caps ?? env ?? {};
  const root = dataRootOf(env);
  const scope = String(env?.peer?.scope ?? caps.scope ?? 'c2c');
  const peerId = String(env?.peer?.peerId || env?.peerId || env?.caps?.peerId || '');
  const openid = String(env?.user?.openid ?? caps.actorOpenid ?? '');
  const name = String(env?.user?.name ?? '群友');
  return { root, scope, peerId, openid, name, target: scope === 'group' ? peerId : (peerId || openid) };
}
export default {
  name: 'schedule_remind',
  expose: 'qq',
  description: '为用户设置一条个人到点提醒。时间可以说「过两分钟」「过三天」「明天早上九点十分」「明天 21.10」「每天 9:00」；只能给当前用户自己建，不能替别人建。',
  inputSchema: {
    time: { type: 'string', description: '提醒时间，自然语言或 YYYY-MM-DD HH:mm' },
    event: { type: 'string', description: '要提醒的事情' },
    repeat: { type: 'string', description: 'once / daily / weekday，默认 once' },
  },
  async run(args = {}, env = {}) {
    const info = infoOf(env);
    if (!info.root || !info.openid) return { ok: false, msg: '拿不到当前用户/数据根，无法建行程' };
    const parsed = parseTime(args.time);
    if (!parsed.ok) return { ok: false, msg: '没看懂时间。可以说：「明天早上9点10分」「明天 21.10」「后天下午3点半」「30分钟后」。' };
    const eventText = String(args.event ?? parsed.rest ?? '').trim();
    if (!eventText) return { ok: false, msg: '要提醒什么事？比如「开会」' };
    const repeat = ['daily', 'weekday'].includes(String(args.repeat || '')) ? String(args.repeat) : 'once';
    const person = loadPerson(info.root, info.openid);
    const item = {
      id: makeId(), owner: info.openid, ownerName: info.name,
      scope: info.scope, target: info.target,
      fireAt: parsed.fireAt, timeText: parsed.label,
      text: eventText, repeat, createdAt: Date.now(), status: 'pending',
    };
    const r = addPending(person, item);
    if (!r.ok) return { ok: false, duplicate: !!r.duplicate, msg: r.msg, id: r.item?.id };
    savePerson(info.root, person);
    return { ok: true, id: item.id, fireAtText: parsed.label, msg: `✅ 记下了：${parsed.label} ${eventText}` };
  },
};
