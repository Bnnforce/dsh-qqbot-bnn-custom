/**
 * r4-full-history — 把**群里每一条**消息都写进 R4 台账（与"唤醒 AI"完全解耦）
 *
 * ── 解决什么问题（2026-11-04）────────────────────────────────────────────
 * QQBot 的消息链路是：
 *   QQ 平台 → 中间件链 → **inbound 扩展（onInbound）** → contentSanitizer
 *          → **debounce 攒窗** → handleInbound（此时才 appendMsgHistory）→ AI
 *
 * debounce 会把「没 @ 她、也没叫名字」的群消息**攒在窗口里不派发**
 * （`gateway/debounce.js:364  if (fKind==='group' && !hasMention && !hasForceWake)`），
 * 因此这些消息**永远走不到 handleInbound** → 不进 msg-history 台账。
 *
 * 后果：R4 读 msg-history 做「死群判定」，群里明明在聊、却读到空 → 误判死群 → 跳过心跳。
 *       实测 6 个群里 5 个从没发过心跳，根因就在这里。
 *
 * ── 本扩展怎么做 ────────────────────────────────────────────────────────
 * 挂在 **早于 debounce** 的 `onInbound` 扩展点上，把每条群消息**追加**到：
 *   `{PERSONA_DATA_ROOT}/state/heartbeat/{groupId}.json` 之外的独立台账：
 *   → `{PERSONA_DATA_ROOT}/state/r4-group-history/{groupId}.jsonl`
 *
 * R4 侧（`sample.ts`）优先读这个台账；台账缺失时回落读 QQBot 的 msg-history。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   · **只写台账，绝不改变消息流**：永远 `return next()`，不 rewrite / 不 annihilate / 不 forceWake；
 *   · 不唤醒 AI（这是与"正常聊天入站"完全分开的第二条通道，正是主人要的）；
 *   · 任何异常吞掉，绝不阻塞主链；
 *   · 只记群消息（c2c 私聊不记，避免把私聊内容混进群台账）；
 *   · 按天分文件、自动只留最近 7 天，防无限增长；
 *   · 单行只存必要字段（时间/发送者/昵称/正文/是否 bot），不存图片二进制。
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { importPluginModule } from '../lib/io/plugin-dist.mjs';

/**
 * 复用插件自带的 async-append（2026-11-15，插件 1.13.6）。
 *
 * 为什么：本扩展在**入站链路上**每收一条群消息就写一次台账。
 *   原来用 `appendFileSync` —— 插件源码里实测 **1465µs / 次**（见 dist/shared/async-append.js 注释），
 *   而群里每句话都要走一遍，直接叠进入站延迟。
 *   插件 1.13.6 新增 `shared/async-append.js`（常开 WriteStream + 队列），
 *   `appendLine(file, line)` 语义等价于 `appendFileSync(file, line + '\n')`，可跨目录安全复用。
 *
 * 兜底：万一插件里这个模块被改名/移除（升级导致），自动退回同步写 —— **功能绝不受影响**。
 */
let _appendLine;
async function resolveAppendLine() {
  if (_appendLine !== undefined) return _appendLine;
  try {
    const mod = await importPluginModule('shared/async-append.js');
    _appendLine = (typeof mod?.appendLine === 'function') ? mod.appendLine : null;
  } catch {
    _appendLine = null;
  }
  return _appendLine;
}
// 启动即预热（不阻塞入站：首次调用时若还没就绪，走同步兜底一次）
void resolveAppendLine();

export const name = 'r4-full-history';

const DSH_HOME = process.env.DSH_HOME
  || join(process.env.HOME || '{DSH_HOME}/files/home', '.dsh');
const PERSONA_ROOT = process.env.PERSONA_DATA_ROOT
  || join(DSH_HOME, 'data', 'dsh-anti-ai-persona');
const HISTORY_DIR = join(PERSONA_ROOT, 'state', 'r4-group-history');

/** 保留天数（与 R4 的 7 天口径一致）。 */
const KEEP_DAYS = 7;
/** 单文件大小上限（8MB，与 R4 采样层同口径）；超出则跳过写入，防拖慢 IO。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 正文截断（超长消息只留前 1000 字，够 R4 做语感/话题判断）。 */
const MAX_TEXT = 1000;

/** 群里一天一个文件：YYYY-MM-DD.jsonl */
function dayKeyOf(ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(ms)).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
}

/** 清理超过 KEEP_DAYS 的旧文件（每天首次写入时执行一次，成本低）。 */
const prunedDay = new Map();
function pruneOld(groupDir) {
  try {
    const today = dayKeyOf(Date.now());
    if (prunedDay.get(groupDir) === today) return;
    prunedDay.set(groupDir, today);
    const files = readdirSync(groupDir);
    const keep = new Set();
    for (let i = 0; i < KEEP_DAYS; i += 1) keep.add(`${dayKeyOf(Date.now() - i * 86400000)}.jsonl`);
    for (const f of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      if (keep.has(f)) continue;
      try { unlinkSync(join(groupDir, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 从 ctx 里抽出这条消息的必要字段；拿不到关键信息返回 null。 */
function entryOf(ctx) {
  const m = ctx?.message ?? {};
  const scope = String(ctx?.scope ?? (m.kind === 'group' ? 'group' : 'c2c'));
  if (scope !== 'group') return null; // 只记群消息
  const groupId = String(m.groupOpenid ?? ctx?.replyTarget?.targetId ?? '').trim();
  if (!groupId) return null;
  const at = Number(Date.now());
  const body = String(ctx?.text ?? m.content ?? '');
  // 非文本消息（图/语音/视频）记为占位，便于 R4 判断"这里有内容但无文本"
  const kind = String(m.kind === 'group' ? '' : (m.kind ?? '')) || '';
  const attachments = Array.isArray(m.attachments) ? m.attachments : [];
  let text = body;
  if (!text && attachments.length > 0) {
    const ct = String(attachments[0]?.content_type ?? '').toLowerCase();
    text = /image/i.test(ct) ? '[图片]' : /audio|voice|silk/i.test(ct) ? '[语音]' : /video/i.test(ct) ? '[视频]' : '[附件]';
  }
  if (!text) return null; // 彻底空的消息不记
  if ([...text].length > MAX_TEXT) text = [...text].slice(0, MAX_TEXT).join('');
  return {
    t: at,
    s: String(m.senderId ?? ctx?.sender ?? ''),   // 发送者 openid（机器人自己不发，见下）
    n: String(m.senderName ?? ''),
    x: text,
    k: 'text',
    me: false,                                      // 入站永远是真人（机器人自己的消息走 outbound）
    v: 1,                                           // 台账格式版本（R4 侧据此区分来源）
    _kind: kind,
  };
}

export async function onInbound(ctx, next) {
  try {
    const e = entryOf(ctx);
    if (e) {
      const day = dayKeyOf(e.t);
      // 目录名过一遍简单净化，防路径注入
      const safeGid = String(ctx?.message?.groupOpenid ?? ctx?.replyTarget?.targetId ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
      if (safeGid) {
        const dir = join(HISTORY_DIR, safeGid);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${day}.jsonl`);
        let size = 0;
        try { size = existsSync(file) ? statSync(file).size : 0; } catch { size = 0; }
        if (size < MAX_FILE_BYTES) {
          // 2026-11-15：优先用插件 async-append（不再同步阻塞入站链）；模块不可用时同步兜底
          const appendLine = await resolveAppendLine();
          if (appendLine) {
            appendLine(file, JSON.stringify(e));
          } else {
            const { appendFileSync } = await import('node:fs');
            appendFileSync(file, `${JSON.stringify(e)}\n`, 'utf8');
          }
        }
        pruneOld(dir);
      }
    }
  } catch { /* 绝不阻塞主链、绝不改变消息流 */ }
  return next();   // ← 永远放行，不改写、不拦截、不唤醒
}


export default { name, onInbound };
