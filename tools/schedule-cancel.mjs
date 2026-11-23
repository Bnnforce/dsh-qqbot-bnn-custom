/** 删除自己的行程（工具） */
import { dataRootOf, loadPerson, savePerson, findByIdPrefix, localStamp } from '../lib/itinerary.mjs';

function infoOf(env) {
  const caps = env?.caps ?? env ?? {};
  return {
    root: dataRootOf(env),
    scope: String(env?.peer?.scope || caps.scope || 'c2c'),
    openid: String(env?.user?.openid ?? caps.actorOpenid ?? ''),
    isOwner: env?.user?.isOwner === true || (Array.isArray(env?.owners) && env.owners.includes(String(env?.user?.openid ?? caps.actorOpenid ?? ''))),
  };
}
export default {
  name: 'schedule_cancel_item',
  expose: 'qq',
  description: '删除一条自己的行程。默认只能删自己的；主人可以用 who 指定他人后删除。',
  inputSchema: {
    id: { type: 'string', description: '行程 id 或前 6 位' },
    who: { type: 'string', description: '可选，仅主人：要操作的人的 openid' },
  },
  async run(args = {}, env = {}) {
    const info = infoOf(env);
    if (!info.root || !info.openid) return { ok: false, msg: '拿不到当前用户/数据根' };
    let owner = info.openid;
    if (args.who) {
      if (!info.isOwner) return { ok: false, msg: '你还没有该权限哦' };
      owner = String(args.who).trim();
    }
    const person = loadPerson(info.root, owner);
    const hit = findByIdPrefix(person.pending, args.id);
    if (!hit) return { ok: false, msg: '没找到这条行程：' + String(args.id || '') };
    person.pending = person.pending.filter((x) => x !== hit);
    savePerson(info.root, person);
    return { ok: true, msg: `已删除：${localStamp(hit.fireAt)} ${hit.text}（${hit.id.slice(0, 6)}）` };
  },
};
