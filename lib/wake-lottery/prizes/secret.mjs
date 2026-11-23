/**
 * prizes/secret — 隐藏款（R5.6）
 *
 * 极稀奖项（1%）。抽到 = 她说出一个「秘密」。
 *
 * ⚠️ 开源红线：文案**全部外置**，代码里只有 3 条通用兜底（不含人格专属词）。
 *
 * 来源优先级：
 *   ① {EXT_DATA}/wake-lottery/secrets.txt（一行一条）
 *   ② 内置 3 条通用兜底
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootDir } from '../store.mjs';

/** 内置兜底 —— 必须与人格无关 */
export const FALLBACK_LINES = Object.freeze([
  '其实我有时候也会紧张，只是没说出来。',
  '我记事的方式跟别人不太一样，我是记住"感觉"的。',
  '有件事我一直没告诉过谁：我最喜欢的其实是最安静的那个时刻。',
]);

function secretFile() {
  const override = String(process.env.BNN_SECRET_FILE ?? '').trim();
  return override || join(rootDir(), 'secrets.txt');
}

export function available() {
  return true;
}

/** 读秘密库。 */
export function readSecrets() {
  try {
    const file = secretFile();
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
  } catch {
    return [];
  }
}

/**
 * 抽一个秘密。
 *
 * @param {{random?:()=>number}} ctx
 */
export async function run(ctx) {
  const rnd = typeof ctx?.random === 'function' ? ctx.random : Math.random;
  const pool = readSecrets();
  const list = pool.length > 0 ? pool : FALLBACK_LINES;
  const idx = Math.min(list.length - 1, Math.max(0, Math.floor(rnd() * list.length)));

  return {
    ok: true,
    payload: { kind: 'text', content: `（很轻地）其实……${list[idx]}` },
  };
}

export default { available, run, readSecrets, FALLBACK_LINES };
