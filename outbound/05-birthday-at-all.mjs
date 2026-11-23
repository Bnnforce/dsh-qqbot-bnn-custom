/**
 * birthday-at-all — 生日祝福强制 `@全体成员`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-11-05 主人要求：
 *   「把那个生日改成直接艾特全体成员，不艾特那个生日的人了」
 *
 * 为什么不在 prompt 里让模型自己写 `<@all>`：
 *   模型不一定每次都照做（实测它会自由发挥），而 @全体 是**结构信息**，不该交给模型。
 *   所以走「标记 + 出站强制」：
 *     ① `hooks/birthday-auto.mjs` 在 wakeTo 之前写**本群**的标记
 *        `birthday-pending/<gid>.json`（含 gid + 时间 + 名单 + expiresAt）；
 *     ② 本扩展在出站链里认领这条回复，给正文开头补 `<@all>`，**用完立刻删标记**；
 *     ③ TTL 兜底：wakeTo 成功但 agent 沉默/只发媒体时，标记由 birthday-auto 的下一次
 *        tick 清掉；本扩展读到过期标记也会直接忽略并删除；
 *     ④ 向后兼容：升级前留下的单文件 `birthday-pending.json` 仍可消费（读旧 + 删旧）。
 *
 * 顺序为什么是 `05-`：
 *   必须排在 `10-ensure-at-back` **之前**。这样文本里先有蓝 @ `<@all>`，
 *   ensure-at-back 看到「已有蓝 @ 且不是回复对象」→ 直接放行不改写（它的规则里有这一条），
 *   不会再多补一个 `<@senderId>` 出来。
 *
 * 安全边界：
 *   · 只处理 group 的 text/markdown，只处理第一块正文（chunkIndex 0）；
 *   · 正文里已经有 `<@all>` / `@全体成员` → 不重复加；
 *   · 标记按群隔离：A 群的标记绝不会被 B 群的消息消费/清除；
 *   · 过期标记不加 @，并且会被清掉（wakeTo 成功 ≠ agent 会回复）；
 *   · 任何异常都不影响发送（最坏情况就是没加 @全体，祝福照发）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA } from '../lib/pack-paths.mjs';

export const name = 'birthday-at-all';

/** 与 birthday-auto 的写路径保持一致：`{dataRoot}/.qqbot-extensions/data/birthday-pending/`。 */
const PENDING_DIR = join(EXT_DATA, 'birthday-pending');
/** 升级前的单文件：仍可消费（读旧 + 删旧），不会被新代码写入。 */
const LEGACY_PENDING_FILE = join(EXT_DATA, 'birthday-pending.json');
/** 老标记没有 expiresAt，按 `at + 5 分钟` 兜底判定（与新标记 TTL 同口径）。 */
const WINDOW_MS = 5 * 60 * 1000;
/** 已经自带 @全体 的形态（QQ 的 `<@all>` / `<@!all>` / 纯文字）。 */
const AT_ALL_RE = /<@!?all>|@全体成员/iu;

/** gid 拼进文件名前必须清洗（与 birthday-auto 的 safeGid 同规则，防路径穿越）。 */
function safeGid(gid) {
  const s = String(gid ?? '').trim();
  if (!s) return '';
  const safe = s.replace(/[^0-9A-Za-z_-]+/g, '_');
  return safe && safe !== '.' && safe !== '..' ? safe : '';
}
function pendingFileOf(gid) {
  const safe = safeGid(gid);
  return safe ? join(PENDING_DIR, `${safe}.json`) : '';
}
function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}
function remove(file) {
  try { unlinkSync(file); } catch { /* 不存在/已被消费：忽略 */ }
}
/** 过期判定：优先 expiresAt；老标记按 at + WINDOW_MS 兜底。无效标记视为过期。 */
function isExpired(pending, now = Date.now()) {
  const expiresAt = Number(pending?.expiresAt ?? 0);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return now > expiresAt;
  const at = Number(pending?.at ?? 0);
  if (!Number.isFinite(at) || at <= 0) return true;
  return now - at > WINDOW_MS;
}

/**
 * 认领本群的待发标记：
 *   ① 先读 per-group 文件（正常路径，多群同日互不影响）；
 *   ② 再兜底旧单文件 `birthday-pending.json`（升级前残留，gid 必须匹配才消费）；
 *   ③ 本群不该消费、但已过期的标记顺手清掉（别让垃圾文件越攒越多）。
 *
 * @returns {{pending: object, file: string}|null}
 */
function claimPending(gid) {
  const candidates = [];
  const own = pendingFileOf(gid);
  if (own) candidates.push(own);
  candidates.push(LEGACY_PENDING_FILE);

  for (const file of candidates) {
    const pending = readJson(file);
    if (!pending) continue;
    if (String(pending.gid ?? '') !== gid) {
      // 别的群的标记：绝不消费、绝不清（除非它已经过期）。
      if (isExpired(pending)) remove(file);
      continue;
    }
    if (isExpired(pending)) { remove(file); continue; }
    return { pending, file };
  }
  return null;
}

export default async function onOutbound(ctx, next) {
  try {
    const kind = String(ctx?.kind ?? 'text');
    if (kind !== 'text' && kind !== 'markdown') return next();
    if (typeof ctx?.chunkIndex === 'number' && ctx.chunkIndex > 0) return next();
    if (String(ctx?.target?.scope ?? '') !== 'group') return next();
    const gid = String(ctx?.target?.targetId ?? '');
    if (!gid) return next();

    const found = claimPending(gid);
    if (!found) return next();

    const text = String(ctx?.text ?? '');
    // 空正文（纯媒体/空块）先不动标记：真正的文本块马上会来。
    if (!text.trim()) return next();
    // 模型自己已经写了 @全体 → 不重复加，标记也已完成使命。
    if (AT_ALL_RE.test(text)) { remove(found.file); return next(); }

    try { ctx.rewrite?.(`<@all> ${text}`); } catch { /* ignore */ }
    remove(found.file);
    try { ctx.logger?.info?.(`[birthday-at-all] 已给生日祝福补 @全体成员（${gid}）`); } catch { /* ignore */ }
  } catch { /* 任何异常都不能影响发送 */ }
  return next();
}
