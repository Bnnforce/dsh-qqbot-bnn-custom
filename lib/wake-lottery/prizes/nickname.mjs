/**
 * prizes/nickname — 专属称呼（R5.6）
 *
 * 她当天给这个群一个「新的称呼」，存进状态文件。
 *
 * 规则（最终方案 §5.3 R28）：
 *   · 一天只允许一个称呼，冲突则覆盖
 *   · 只存哈希（不存 openid 明文）
 *   · 读不到就返回 ok:false → 换奖
 */
import { readJsonSafe, writeJsonAtomic, diag } from '../store.mjs';
import { rootDir } from '../store.mjs';
import { join } from 'node:path';

/** 称呼候选（通用，不含具体人名）。 */
const CANDIDATES = Object.freeze([
  '小朋友', '老朋友', '同伙', '隔壁的', '偷懒的', '还没睡的',
  '话多的', '安静的', '爱笑的', '认真的',
]);

/** 称呼文件。 */
function nicknameFile(gid) {
  const s = String(gid ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
  return join(rootDir(), `_nickname-${s}.json`);
}

export function available() {
  return true;
}

/**
 * 抽一个专属称呼并记录。
 *
 * @param {{gid:string, nowMs?:number, random?:()=>number, timezone?:string}} ctx
 */
export async function run(ctx) {
  try {
    const gid = String(ctx?.gid ?? '').trim();
    if (!gid) return { ok: false, reason: 'no-gid' };

    const rnd = typeof ctx?.random === 'function' ? ctx.random : Math.random;
    const idx = Math.min(CANDIDATES.length - 1, Math.max(0, Math.floor(rnd() * CANDIDATES.length)));
    const name = CANDIDATES[idx];
    const now = Number.isFinite(Number(ctx?.nowMs)) ? Number(ctx.nowMs) : Date.now();
    const dateKey = new Date(now).toISOString().slice(0, 10);

    const file = nicknameFile(gid);
    const prev = readJsonSafe(file);
    const sameDay = prev && prev.date === dateKey;

    const ok = writeJsonAtomic(file, {
      date: dateKey,
      name,
      at: now,
      // 一天只允许一个：冲突覆盖（R28）
      prev: sameDay ? String(prev?.name ?? '') : '',
    });

    if (!ok) { diag(`[称呼] gid=${gid} 写失败`); return { ok: false, reason: 'nickname-write-failed' }; }

    return {
      ok: true,
      payload: {
        kind: 'text',
        content: sameDay && prev?.name && prev.name !== name
          ? `今天就把你叫『${name}』吧。（之前那个不算了）`
          : `今天叫你『${name}』。`,
      },
    };
  } catch (e) {
    return { ok: false, reason: `nickname-error:${e instanceof Error ? e.message : String(e)}` };
  }
}

export default { available, run };
