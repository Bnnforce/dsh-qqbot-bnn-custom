/**
 * recent-media — 最近消息环形缓冲，给「@ 前后附近图片」兜底。
 *
 * 只存元数据，不下载；进程内 Map，重启即清空。
 * 规则：同群 + 同发送者 + 120 秒内 + 最多回看 10 条 + 最多 3 张图。
 */
const KEY = Symbol.for('qqbot.recent-media.v1');
const MAX_ENTRIES_PER_PEER = 20;
const MAX_PEERS = 200;
export const MAX_AGE_MS = 120_000;
export const MAX_SCAN_MESSAGES = 10;
export const MAX_NEARBY_IMAGES = 3;

function buffer() {
  let m = globalThis[KEY];
  if (!(m instanceof Map)) { m = new Map(); globalThis[KEY] = m; }
  return m;
}
function peerKey(ctx) {
  const scope = String(ctx?.scope ?? '');
  const m = ctx?.message ?? {};
  const peer = scope === 'group'
    ? (m.groupOpenid ?? ctx?.replyTarget?.targetId ?? '')
    : (m.senderId ?? m.senderOpenid ?? ctx?.replyTarget?.targetId ?? '');
  return `${scope}:${peer}`;
}
function senderOf(ctx) {
  const m = ctx?.message ?? {};
  return String(m.senderId ?? m.senderOpenid ?? ctx?.sender?.openid ?? ctx?.senderId ?? '');
}
function idOf(ctx, at) {
  const m = ctx?.message ?? {};
  const raw = m.msgId ?? m.msg_id ?? m.messageId ?? m.id ?? '';
  if (raw) return String(raw);
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  return `${senderOf(ctx)}:${at}:${atts.map((a) => String(a?.url ?? '')).join('|')}`;
}
export function isImageAttachment(att) {
  const ct = String(att?.content_type ?? att?.contentType ?? '').toLowerCase().trim();
  if (ct === 'image' || ct.startsWith('image/')) return true;
  const name = String(att?.filename ?? '').toLowerCase();
  const url = String(att?.url ?? '');
  if (/\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)(?:[?#\s]|$)/i.test(`${name} ${url}`)) return true;
  if (att?.width && att?.height) return true;
  if (/[?&]appid=(1406|1407)(?:[&#]|$)/i.test(url)) return true;
  return false;
}
function prune(list, now) {
  return list.filter((x) => now - x.at <= MAX_AGE_MS);
}

/** 记录一条入站消息；只保存在进程内存。 */
export function remember(ctx) {
  try {
    const key = peerKey(ctx);
    if (!key || key === ':') return;
    const at = Date.now();
    const atts = Array.isArray(ctx?.message?.attachments)
      ? ctx.message.attachments.slice(0, 9)
      : [];
    const entry = {
      id: idOf(ctx, at),
      at,
      sender: senderOf(ctx),
      attachments: atts,
      consumed: false,
    };
    const m = buffer();
    const list = m.get(key) || [];
    // 同一条消息重复进入时只保留最新
    const dedup = list.filter((x) => x.id !== entry.id);
    dedup.push(entry);
    m.set(key, prune(dedup, at).slice(-MAX_ENTRIES_PER_PEER));
    // 防止长期运行下群/会话键无限增长
    if (m.size > MAX_PEERS) {
      for (const [k, v] of m) {
        const kept = prune(v || [], at);
        if (!kept.length) m.delete(k);
        else m.set(k, kept.slice(-MAX_ENTRIES_PER_PEER));
        if (m.size <= MAX_PEERS) break;
      }
    }
  } catch { /* ignore */ }
}

/** 取当前 @ 之前、同发送者、最近窗口内的图片附件。 */
export function nearbyMedia(ctx, opts = {}) {
  try {
    const maxAge = Number(opts.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : MAX_AGE_MS;
    const maxMessages = Math.max(1, Math.min(20, Number(opts.maxMessages) || MAX_SCAN_MESSAGES));
    const maxImages = Math.max(1, Math.min(6, Number(opts.maxImages) || MAX_NEARBY_IMAGES));
    const key = peerKey(ctx);
    const sender = senderOf(ctx);
    const curId = idOf(ctx, Date.now());
    const now = Date.now();
    const list = (buffer().get(key) || [])
      .filter((x) => x && !x.consumed && x.id !== curId && x.sender === sender)
      .filter((x) => now - x.at <= maxAge)
      .slice(-maxMessages);
    const ids = [];
    const attachments = [];
    const seen = new Set();
    for (const entry of list) {
      if (!ids.includes(entry.id)) ids.push(entry.id);
      for (const att of entry.attachments || []) {
        if (!isImageAttachment(att)) continue;
        const k = String(att.url ?? att.filename ?? JSON.stringify(att));
        if (seen.has(k)) continue;
        seen.add(k);
        attachments.push(att);
        if (attachments.length >= maxImages) return { attachments, ids, entries: list };
      }
    }
    return { attachments, ids, entries: list };
  } catch {
    return { attachments: [], ids: [], entries: [] };
  }
}
export function consumeMedia(ctx, ids) {
  try {
    const key = peerKey(ctx);
    const set = new Set(Array.isArray(ids) ? ids : []);
    const m = buffer();
    const list = m.get(key) || [];
    for (const x of list) if (set.has(x.id)) x.consumed = true;
    m.set(key, list.filter((x) => !x.consumed).slice(-MAX_ENTRIES_PER_PEER));
  } catch { /* ignore */ }
}
export function formatTime(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
