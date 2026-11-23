/**
 * roam/videoshot — 画面通道：雪碧图 → 图片块（R5.7）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件
 *   插件的 bilibili_frames 有 bug：它找 data.preview_pic，
 *   但 /x/player/wbi/v2 早已不返回该字段（实测 40+ 字段里没有）⇒ 永远拿不到图。
 *   真正的位置是 /x/player/videoshot，这里自己实现。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 实测数据（2026-11-22）
 *   · videoshot 返回 img_x_len/img_y_len = 10x10（网格）
 *   · img_x_size/img_y_size = 480x270（单帧逻辑尺寸）
 *   · image[] 通常 6 张，每张是 4800x2700 的 JPEG（含 100 帧）
 *   · 单张约 600~750 KB
 *
 *   ⇒ 只下第 1 张就够判断调性，省 5/6 流量。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { fetchVideoshotInfo, fetchImageBytes } from './bili-api.mjs';
import { diag } from './store.mjs';

/** 单张雪碧图的帧数（10x10）。 */
const FRAMES_PER_SHEET = 100;

/**
 * 取画面：返回可直接塞进 attachments 的图片字节。
 *
 * @param {{bvid:string,cid:number}} param
 * @param {object} cfg
 * @returns {Promise<{ok:true,sheets:Array<{data:Buffer,mediaType:string}>,gridX:number,gridY:number,frameW:number,frameH:number}|{ok:false,reason:string}>}
 */
export async function fetchFrames(param, cfg) {
  try {
    const info = await fetchVideoshotInfo(param, cfg);
    if (!info) {
      diag('[画面] ' + param.bvid + ' 无预览图');
      return { ok: false, reason: 'no-videoshot' };
    }

    const maxPages = Number.isFinite(cfg?.videoshotMaxPages) ? cfg.videoshotMaxPages : 1;
    const want = Math.max(1, Math.min(maxPages, info.images.length));
    const sheets = [];

    for (let i = 0; i < want; i++) {
      try {
        const img = await fetchImageBytes(info.images[i]);
        sheets.push(img);
      } catch (e) {
        diag('[画面] ' + param.bvid + ' 第' + (i + 1) + '张下载失败: ' + (e?.code || e?.message || e));
        // 一张失败不影响其他
      }
    }

    if (sheets.length === 0) return { ok: false, reason: 'download-failed' };

    diag('[画面] ' + param.bvid + ' 成功 ' + sheets.length + ' 张 / 网格 ' + info.gridX + 'x' + info.gridY);
    return {
      ok: true,
      sheets,
      gridX: info.gridX,
      gridY: info.gridY,
      frameW: info.frameW,
      frameH: info.frameH,
    };
  } catch (e) {
    diag('[画面] ' + param.bvid + ' 异常: ' + (e?.code || e?.message || e));
    return { ok: false, reason: e?.code || 'error' };
  }
}

/**
 * 生成给模型的画面说明（文字部分）。
 *
 * ⚠️ 只描述结构，不描述内容 —— 内容由模型自己看。
 *
 * @param {{gridX:number,gridY:number,frameW:number,frameH:number,sheets:number}} info
 * @returns {string}
 */
export function describeFrames(info) {
  const gx = Number(info?.gridX) || 10;
  const gy = Number(info?.gridY) || 10;
  const n = Number(info?.sheets) || 1;
  return '<frames sheets="' + n + '" grid="' + gx + 'x' + gy + '" per_sheet="' + (gx * gy) + '">'
    + '这是视频画面的采样雪碧图，每张 ' + gx + 'x' + gy + ' 网格排列了 ' + (gx * gy) + ' 帧，'
    + '从左到右、从上到下按时间顺序。'
    + '</frames>';
}

export default { fetchFrames, describeFrames, FRAMES_PER_SHEET };
