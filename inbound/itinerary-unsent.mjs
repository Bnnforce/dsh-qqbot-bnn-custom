/** 下次该用户说话时，把他的失败提醒静默补进上下文（不唤醒 AI）。 */
import { dataRootOf, loadPerson, savePerson } from '../lib/itinerary.mjs';

export async function onInbound(ctx, next) {
  try {
    const root = dataRootOf(ctx);
    const openid = String(ctx?.caps?.actorOpenid ?? ctx?.message?.senderId ?? ctx?.sender ?? '');
    if (!root || !openid) return next();
    const person = loadPerson(root, openid);
    if (!person.unsent?.length) return next();
    const text = person.unsent.map((x) => `· ${x.text}`).join('\n');
    const inject = typeof ctx?.silentInto === 'function' ? ctx.silentInto : ctx?.caps?.inbound?.silentInto;
    if (typeof inject === 'function') {
      await inject(`[行程提醒补发] 上次有几条提醒没有发出去：\n${text}`);
      person.unsent = [];
      savePerson(root, person);
    }
  } catch { /* fail soft */ }
  return next();
}
