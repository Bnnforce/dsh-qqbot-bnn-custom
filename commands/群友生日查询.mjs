/**
 * /群友生日查询
 * 一个群一个生日档；群成员可查本群、可登记自己的生日；主人可加/改/删任意群友。
 */
import {
  dataRootOf, groupIdOf, listBirthdays, parseBirthdayDate,
  saveBirthday, removeBirthday, renderQuery, isOwner,
} from '../lib/birthday.mjs';

function info(ctx) {
  const caps = ctx?.caps ?? ctx ?? {};
  return {
    root: dataRootOf(ctx),
    gid: groupIdOf(ctx),
    name: String(ctx?.senderName ?? ctx?.message?.senderName ?? caps.user?.name ?? '').trim(),
  };
}
const HELP = [
  '可以这样用：',
  '/群友生日查询             看本群今天和未来 7 天',
  '/群友生日查询 全部        看本群全部生日档',
  '/群友生日查询 加 3月15日       登记自己的生日',
  '/群友生日查询 加 张三 1月19日   主人给任意群友添加/修改',
  '/群友生日查询 删除 张三         主人删除',
].join('\n');

export default {
  name: ['群友生日查询', '生日查询'],
  description: '按当前群查询/添加/删除群友生日；一群一档，不跨群',
  usage: '/群友生日查询 [全部 | 加 昵称 1月19日 | 删除 昵称]',
  async handler(ctx) {
    const i = info(ctx);
    if (!i.root) return '拿不到数据根，暂时用不了生日档。';
    if (!i.gid) return '这个功能只能在群里用；私聊不跨群查生日。';
    const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();

    if (!raw) return renderQuery(i.root, i.gid, 'week');
    if (raw === '全部') return renderQuery(i.root, i.gid, 'all');

    const owner = isOwner(ctx);
    const add = /^(?:加|添加|新增)\s+(.+)$/.exec(raw);
    if (add) {
      const rest = add[1].trim();
      const two = /^(.*?)\s+(\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?)$/.exec(rest);
      let person = two ? two[1].trim() : '';
      const date = parseBirthdayDate(two ? two[2] : rest);
      if (!date) return '日期没看懂。可以这样写：/群友生日查询 加 3月15日';
      if (!owner) {
        if (person && person !== i.name) return `群友只能登记自己的生日喔，发 /群友生日查询 加 ${date.month}月${date.day}日 就记在你名下`;
        if (!i.name) return '拿不到你的昵称，暂时登记不了。';
        person = i.name;
      }
      if (!person) return '要加谁的生日呀？';
      saveBirthday(i.root, i.gid, person, date.month, date.day, owner ? '主人手动添加' : '本人在群里登记');
      return `✅ 已加入本群生日：${person} ${date.month}月${date.day}日`;
    }

    let m = /^(?:删除|删)\s+(.+)$/.exec(raw);
    if (m) {
      if (!owner) return '你还没有该权限哦';
      const person = m[1].trim();
      return removeBirthday(i.root, i.gid, person) ? `已删除：${person}` : `本群没有找到「${person}」的生日档。`;
    }

    return HELP;
  },
};
