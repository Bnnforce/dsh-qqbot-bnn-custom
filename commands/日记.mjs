/**
 * 日记 —— 看她的日记（谁都能看，读今日/昨日）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用法：
 *   /日记            → 今天的日记
 *   /日记 昨天       → 昨天的日记
 *   /日记 2026-11-23 → 指定日期
 *
 * ── 谁都能看（主人定的）──────────────────────────────────────────────────
 *
 *   日记本来就是「她自己的记录」，不设权限。但内容已脱敏
 *   （diary-task 生成时，prompt 铁律要求不写群友昵称/openid），
 *   所以公开无害。
 *
 * ── 群隔离 ──────────────────────────────────────────────────────────────
 *
 *   只看「本群」的日记（按当前群 gid 定位目录），不跨群。
 *
 * ── 展示形式 ─────────────────────────────────────────────────────────────
 *
 *   用 QQ markdown 卡片（msg_type=2），带标题 + 分隔线，比纯文本美观。
 *   没有交互按钮，所以不用 markdownCard，用 caps.markdown() 即可。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { currentPersonaOf } from '../lib/io/persona-path.mjs';
import { readDiary, ymdOf, ymdYesterday } from '../lib/diary/store.mjs';

export const name = ['日记', 'diary'];

function peerOf(ctx) {
  const caps = ctx?.caps ?? {};
  const mc = ctx?.message ?? {};
  const gid = String(
    caps.peerId ?? mc.groupOpenid ?? mc.group_openid ?? ctx?.event?.peerId ?? '',
  );
  return /^[0-9A-Fa-f]{32}$/.test(gid) ? gid : '';
}

export default {
  name,
  description: '看她的日记（今天/昨天/指定日期）',
  usage: '/日记 [昨天 | YYYY-MM-DD]',

  async handler(ctx) {
    const gid = peerOf(ctx);
    if (!gid) return { kind: 'text', content: '这个命令只能在群里用哦。' };

    const persona = currentPersonaOf({ peer: { peerId: gid, scope: 'group' } }) || '她';

    // 解析日期
    const arg = String(ctx?.args ?? ctx?.text ?? '').trim();
    let date;
    if (/昨天|昨|yesterday/i.test(arg)) {
      date = ymdYesterday();
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      date = arg;
    } else {
      date = ymdOf();
    }

    const content = readDiary(persona, gid, date);
    if (!content) {
      const hint = date === ymdOf()
        ? '她今天的日记还没写呢（每天 22:30 写）。'
        : `${date} 这天没有日记。`;
      return { kind: 'text', content: hint };
    }

    // markdown 卡片
    const md = [
      `# ${persona}的日记 · ${date}`,
      '',
      '---',
      '',
      content.trim(),
    ].join('\n');

    const caps = ctx?.caps ?? ctx ?? {};
    if (typeof caps?.markdown === 'function') {
      try {
        const ok = await caps.markdown(md);
        if (ok) return '';
      } catch { /* 落到返回文本 */ }
    }
    return { kind: 'text', content: md };
  },
};
