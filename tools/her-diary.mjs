/**
 * her_diary — 读她的日记（群友问了，模型调这个工具取今日/昨日日记）（R6.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用途
 *
 *   群友问「你今天的日记写了啥」「昨天写了什么」，模型调这个工具，
 *   拿到日记正文后用自己的话转述给群友（而不是直接把 md 贴出来）。
 *
 *   与 commands/日记.mjs 的分工：
 *   · 命令 `/日记` → 直接展示日记（卡片，谁都能看）
 *   · 工具 her_diary → 模型查询用（群友随口问，不显式发命令时）
 *
 * ── 群隔离 ──────────────────────────────────────────────────────────────
 *
 *   只读「本群」的日记，不跨群。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { currentPersonaOf } from '../lib/io/persona-path.mjs';
import { readDiary, listDates, ymdOf, ymdYesterday } from '../lib/diary/store.mjs';

function currentGid(env) {
  const scope = String(env?.peer?.scope ?? env?.peerScope ?? '');
  const id = String(env?.peer?.peerId ?? env?.peerId ?? env?.groupId ?? '').trim();
  return scope === 'group' && id ? id : '';
}

export default {
  name: 'her_diary',
  expose: 'qq',
  description:
    '读她（机器人）写的日记。群友问「你今天的日记」「昨天写了什么日记」时用它。' +
    '只能读本群她写的日记，不能读别的群。',
  inputSchema: {
    when: {
      type: 'string',
      description: '可选：哪天，today=今天（默认）、yesterday=昨天，或 YYYY-MM-DD',
    },
  },
  async run(args = {}, env = {}) {
    try {
      const gid = currentGid(env);
      if (!gid) return { ok: false, msg: '这个工具只在 QQ 群里能用（看不到她在这个群的日记）。' };

      const persona = currentPersonaOf({ peer: { peerId: gid, scope: 'group' } }) || '她';

      const when = String(args?.when ?? 'today').trim().toLowerCase();
      let date;
      if (when === 'today' || when === '今天' || !when) date = ymdOf();
      else if (when === 'yesterday' || when === '昨天') date = ymdYesterday();
      else if (/^\d{4}-\d{2}-\d{2}$/.test(when)) date = when;
      else date = ymdOf();

      const content = readDiary(persona, gid, date);
      if (!content) {
        const dates = listDates(persona, gid);
        return {
          ok: true,
          msg: `${date} 这天她没写日记。` + (dates.length ? `已有日记的日期：${dates.slice(0, 5).join('、')}` : ''),
          data: { gid, persona, date, diary: null },
        };
      }

      return {
        ok: true,
        msg: `${persona} ${date} 的日记`,
        data: { gid, persona, date, diary: content.trim() },
      };
    } catch (e) {
      return { ok: false, msg: `读日记时出错了（${e instanceof Error ? e.message : String(e)}）。` };
    }
  },
};
