/**
 * zz-current-sender — 记录“当前这条消息的发送者”，供 hook 的 tools.guard 做 owner 门禁。
 *
 * 背景：DSH 的 channel-tools（send_media / broadcast_send / 群管理等）没有
 * `env.user.isOwner`，而 session record 的 senderId 只在建会话时写一次。
 * 这里在每条入站消息（早挂点）把 `{scope,peerId,senderId,senderName,isOwner,ts}`
 * 写到 globalThis；hooks/zz-tool-security-guard.mjs 在工具执行前读取。
 *
 * 只写内存，不拦消息、不改写、不发消息；异常全部吞掉。
 */
export const name = 'zz-current-sender';

const KEY = Symbol.for('qqbot.current-sender');
import { calledByCurrentText } from '../lib/name.mjs';
const TTL_MS = 15 * 60 * 1000;

function store() {
  let m = globalThis[KEY];
  if (!(m instanceof Map)) {
    m = new Map();
    globalThis[KEY] = m;
  }
  return m;
}

function entryOf(ctx) {
  const m = ctx?.message ?? {};
  const scope = String(ctx?.scope ?? (m.kind === 'group' ? 'group' : 'c2c'));
  const peerId = String(
    scope === 'group'
      ? (m.groupOpenid ?? ctx?.replyTarget?.targetId ?? '')
      : (m.senderId ?? ctx?.replyTarget?.targetId ?? ''),
  );
  const senderId = String(m.senderId ?? ctx?.sender ?? '');
  if (!scope || !peerId || !senderId) return null;
  const quote = ctx?.state?.quote;
  const attachments = [
    ...(Array.isArray(m.attachments) ? m.attachments : []),
    ...(Array.isArray(quote?.attachments) ? quote.attachments : []),
  ];
  const hasImage = attachments.some((a) => {
    const ct = String(a?.content_type ?? a?.contentType ?? '').toLowerCase().trim();
    if (ct === 'image' || ct.startsWith('image/')) return true;
    const name = String(a?.filename ?? '').toLowerCase();
    const url = String(a?.url ?? '');
    if (/\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)(?:[?#\s]|$)/i.test(`${name} ${url}`)) return true;
    if (a?.width && a?.height) return true;
    return /[?&]appid=(1406|1407)(?:[&#]|$)/i.test(url);
  });
  const named = calledByCurrentText(ctx);
  return {
    scope,
    peerId,
    senderId,
    senderName: String(m.senderName ?? ctx?.senderName ?? ''),
    isOwner: ctx?.isOwner === true,
    hasImage,
    mentioned: ctx?.platform?.mentioned === true,
    named,
    // 2026-11-02：记录本条消息正文，供 guard 判断「主人有没有明确要求写文件」。
    // 只留最近 200 字（意图关键词都在句首/句中，不需要全文），避免 Map 里堆长文本。
    text: String(ctx?.text ?? '').slice(0, 200),
    ts: Date.now(),
  };
}

export async function onInbound(ctx, next) {
  try {
    const e = entryOf(ctx);
    if (e) {
      const m = store();
      m.set(`${e.scope}:${e.peerId}`, e);
      if (m.size > 500) {
        const now = Date.now();
        for (const [k, v] of m) if (!v || now - Number(v.ts ?? 0) > TTL_MS) m.delete(k);
      }
    }
  } catch { /* ignore */ }
  return next();
}
