/** 最近消息缓冲：每条入站只记录媒体元数据，供识图兜底（不下载、不落盘）。 */
import { remember } from '../lib/pure/recent-media.mjs';
export async function onInbound(ctx, next) {
  try { remember(ctx); } catch { /* ignore */ }
  return next();
}
