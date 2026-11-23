/** group_birthday：按当前群查询/添加/删除生日档（AI 工具） */
import { dataRootOf, groupIdOf, listBirthdays, parseBirthdayDate, saveBirthday, removeBirthday, renderQuery, isOwner } from '../lib/birthday.mjs';

function info(env) {
  return {
    root: dataRootOf(env),
    gid: groupIdOf(env),
    owner: isOwner(env),
  };
}
export default {
  name: 'group_birthday',
  expose: 'qq',
  /**
   * ★ 2026-11-08 加「优先用 qq_memory」引导（主人要求）。
   *
   * 起因（真机实测）：群里问「瞳的生日是什么时候」，模型直接选了本工具
   * （因为「查询本群今天和未来7天」与问题完美匹配），而 `qq_memory` 是通用记忆工具、
   * 竞争不过专用工具的描述 —— 结果虽然对，但走的是旧入口，且用户看到三个工具
   * （qq_memory / group_memory / group_birthday）抢同一件事。
   *
   * ★ 2026-11-16：`group_memory` 已删除（主人要求记忆入口统一），
   *   现在只有 qq_memory（记忆）与本工具（生日增删/时间窗口）两个。
   *
   * 分工定稿：**查档案/查记忆 → qq_memory**（官方入口、同一份数据）；
   *   本工具只负责「生日的增删」与「今天/未来N天」这类**时间窗口**查询。
   */
  description: '按当前群管理群友生日：action=list 查询本群今天和未来7天；action=all 看全部；action=add 添加/修改（主人可加任意群友，普通群友只能登记自己）；action=remove 主人删除。生日按群独立，不能跨群。'
    + '⚠️ 查某人的记忆/档案优先用 qq_memory（同一份数据、官方入口）；本工具只负责生日的增删，以及「今天/未来几天谁生日」这类时间窗口查询。',
  inputSchema: {
    action: { type: 'string', description: 'list / all / add / remove，默认 list' },
    name: { type: 'string', description: 'add/remove 用：群友昵称' },
    date: { type: 'string', description: 'add 用：生日，如 1月19日 / 01-19 / 1/19' },
  },
  async run(args = {}, env = {}) {
    const i = info(env);
    if (!i.root) return { ok: false, msg: '拿不到数据根' };
    if (!i.gid) return { ok: false, msg: '只能在群里操作生日档。' };
    const action = String(args.action || 'list');
    if (action === 'list') return { ok: true, msg: renderQuery(i.root, i.gid, 'week'), data: listBirthdays(i.root, i.gid) };
    if (action === 'all') return { ok: true, msg: renderQuery(i.root, i.gid, 'all'), data: listBirthdays(i.root, i.gid) };
    if (action === 'add') {
      const d = parseBirthdayDate(args.date);
      if (!d) return { ok: false, msg: '日期没看懂。可以写 1月19日、01-19、1/19。' };
      let name = String(args.name ?? '').trim();
      if (!i.owner) {
        // 群友只能登记自己：一律按说话人昵称落档
        const self = String(env?.user?.name ?? env?.caps?.user?.name ?? '').trim();
        if (!self) return { ok: false, msg: '拿不到你的昵称，暂时登记不了。' };
        name = self;
      }
      if (!name) return { ok: false, msg: '要加谁的生日？' };
      saveBirthday(i.root, i.gid, name, d.month, d.day, i.owner ? '主人手动添加' : '本人在群里登记');
      return { ok: true, msg: `✅ 已加入本群生日：${name} ${d.month}月${d.day}日` };
    }
    if (!i.owner) return { ok: false, msg: '你还没有该权限哦' };
    if (action === 'remove') {
      const name = String(args.name ?? '').trim();
      if (!name) return { ok: false, msg: '要删谁的生日？' };
      return removeBirthday(i.root, i.gid, name) ? { ok: true, msg: `已删除：${name}` } : { ok: false, msg: `本群没有找到「${name}」的生日档。` };
    }
    return { ok: false, msg: 'action 只支持 list / all / add / remove' };
  },
};
