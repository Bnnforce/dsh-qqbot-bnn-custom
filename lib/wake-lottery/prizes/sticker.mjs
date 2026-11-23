/**
 * prizes/sticker — 表情包（R5.6）
 *
 * 从 {DATA_ROOT}/表情包/lib/library/ 随机挑一张。
 *
 * ⚠️ 只读 library/ 目录：
 *   candidate/ = 待审核、negative/ = 负样本、trash/ = 回收站 —— 都不该直接发给用户。
 */
import { join } from 'node:path';
import { DATA_ROOT } from '../../pack-paths.mjs';
import { safeList } from '../../dirs.mjs';

const EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

/** 表情包库目录。 */
function libraryDir() {
  const override = String(process.env.BNN_STICKER_ROOT ?? '').trim();
  return override || join(DATA_ROOT, '表情包', 'lib', 'library');
}

/**
 * 是否可用：library 里至少一张。
 */
export function available() {
  try {
    return safeList(libraryDir(), { filesOnly: true, exts: EXTS }).length > 0;
  } catch {
    return false;
  }
}

/**
 * 抽一张表情包。
 *
 * @param {{random?:()=>number}} [ctx]
 */
export async function run(ctx) {
  try {
    const dir = libraryDir();
    const files = safeList(dir, { filesOnly: true, exts: EXTS });
    if (files.length === 0) return { ok: false, reason: 'sticker-empty' };

    const rnd = typeof ctx?.random === 'function' ? ctx.random : Math.random;
    const idx = Math.min(files.length - 1, Math.max(0, Math.floor(rnd() * files.length)));
    const name = files[idx];

    return {
      ok: true,
      payload: { kind: 'sticker', content: { localPath: join(dir, name), name } },
    };
  } catch (e) {
    return { ok: false, reason: `sticker-error:${e instanceof Error ? e.message : String(e)}` };
  }
}

export default { available, run };
