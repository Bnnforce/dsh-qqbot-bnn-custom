/**
 * prizes/image — 一张图（R5.6）
 *
 * 从 {WORKSPACE}/Bot/美图库/ 随机挑一张。
 * 可用 BNN_IMAGE_ROOT 覆盖（dirs.mjs 已支持）。
 */
import { join } from 'node:path';
import { IMAGE_ROOT, safeList } from '../../dirs.mjs';

/** 支持的图片扩展名。 */
const EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

/**
 * 是否可用：目录里至少有一张图。
 * @returns {boolean}
 */
export function available() {
  try {
    return safeList(IMAGE_ROOT, { filesOnly: true, exts: EXTS }).length > 0;
  } catch {
    return false;
  }
}

/**
 * 抽一张图。
 *
 * @param {{random?:()=>number}} [ctx]
 * @returns {Promise<{ok:true,payload:{kind:'image',content:object}}|{ok:false,reason:string}>}
 */
export async function run(ctx) {
  try {
    const files = safeList(IMAGE_ROOT, { filesOnly: true, exts: EXTS });
    if (files.length === 0) return { ok: false, reason: 'image-empty' };

    const rnd = typeof ctx?.random === 'function' ? ctx.random : Math.random;
    const idx = Math.min(files.length - 1, Math.max(0, Math.floor(rnd() * files.length)));
    const name = files[idx];

    return {
      ok: true,
      payload: {
        kind: 'image',
        content: { localPath: join(IMAGE_ROOT, name), name },
      },
    };
  } catch (e) {
    return { ok: false, reason: `image-error:${e instanceof Error ? e.message : String(e)}` };
  }
}

export default { available, run };
