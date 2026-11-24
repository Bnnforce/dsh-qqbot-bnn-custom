/**
 * aaa-recent-user-text — 记住每个群最近一条用户消息
 *
 * 给 R6.2 语义召回当查询词用。
 *
 * 为什么文件名是 `aaa-`：要**早于其他 inbound** 记录，
 * 保证同一轮里后面的 hook（以及注入阶段）能读到它。
 *
 * 为什么不落盘：每秒可能变一次，且丢了只是召回退化成空（有兜底）。
 */
import { remember } from '../lib/pure/recent-user-text.mjs';

export async function onInbound(ctx, next) {
  try { remember(ctx); } catch { /* 记录失败绝不影响消息处理 */ }
  return next();
}
