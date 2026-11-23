/**
 * her_slang — 查「本群黑话」的完整释义（R4.8）
 *
 * 与 slang-inline hook 的分工：
 *   · hook 已把「词=简短释义」注入到她的上下文（无感，每轮 20 token）
 *   · 本工具负责**问到具体词**时给完整信息（出处/用法/来源）
 *
 * 数据源：{PERSONA_ROOT}/黑话本/<gid前8位>/黑话.md
 * ⚠️ 只读「已确认」，候选.md 永不读（防误判内容进上下文）
 */
import { PERSONA_ROOT } from '../lib/io/persona-store.mjs';
import { readSlang, groupDir } from '../lib/slang/store.mjs';
import { GID_PATTERN } from '../lib/slang/config.mjs';
import { loadState, groupState } from '../lib/io/persona-switch.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function currentGid(env) {
  try {
    const peer = env?.peer || {};
    const id = String(peer.peerId || peer.groupId || env?.groupId || '');
    if (peer.scope && peer.scope !== 'group') return '';
    return GID_PATTERN.test(id) ? id : '';
  } catch { return ''; }
}

export default {
  name: 'her_slang',
  expose: 'qq',
  description:
    '查本群的黑话/自己人造的词（**只查本群黑话本**，不查全网梗）。'
    + '上下文里已经有一行「【本群黑话】词=释义」的速查，**常规对话用那行就够了，不用调这个工具**。'
    + '只有需要**出处/谁先说的/完整用法**时才调用。'
    + '不传 word 则列出本群全部黑话。'
    + '⚠️ 查**全网梗/缩写/网络黑话**（如 yyds、典、kskbl 这类）请用 search_meme_wiki，不要用本工具——本工具只看本群黑话本。',

  inputSchema: {
    word: { type: 'string', description: '可选：要查的词（如"本鲸"）；不传=列出全部' },
  },

  async run(args = {}, env = {}) {
    const gid = currentGid(env);
    if (!gid) return { ok: false, msg: '只能在群里查黑话（拿不到群号）。' };

    // ★ 黑话本是**按群**分的（黑话本/<gid8>/黑话.md），不是按人格分
    //   （2026-11-17 修正：一度误改成按人格，导致已有黑话本读不到）
    const dir = groupDir(PERSONA_ROOT, gid);
    if (!dir || !existsSync(dir)) {
      return { ok: true, msg: '本群还没有黑话本。遇到听不懂的词，可以直接问群友。', data: { exists: false } };
    }

    const all = readSlang(PERSONA_ROOT, gid);
    if (!all.length) {
      return { ok: true, msg: '本群黑话本还是空的（可能还没人工确认）。', data: { exists: true, count: 0 } };
    }

    const w = String(args?.word ?? '').trim();
    if (w) {
      const hit = all.find((s) => s.word === w) || all.find((s) => s.word.includes(w) || w.includes(s.word));
      if (!hit) {
        return {
          ok: true,
          msg: `本群黑话里没有「${w}」。可能是普通词，或者还没收录。\n本群现有：${all.slice(0, 10).map((s) => s.word).join('、')}`,
          data: { found: false, word: w },
        };
      }
      const lines = [`【${hit.word}】`];
      if (hit.definition) lines.push(`释义：${hit.definition}`);
      if (hit.source) lines.push(`出处：${hit.source}`);
      if (hit.usage) lines.push(`用法：${hit.usage}`);
      return { ok: true, msg: lines.join('\n'), data: { found: true, ...hit } };
    }

    const lines = [`本群黑话共 ${all.length} 条：`];
    all.slice(0, 15).forEach((s) => lines.push(`· ${s.word}：${s.definition || s.usage || '（无释义）'}`));
    if (all.length > 15) lines.push(`…还有 ${all.length - 15} 条`);
    return { ok: true, msg: lines.join('\n'), data: { count: all.length, items: all.slice(0, 15) } };
  },
};
