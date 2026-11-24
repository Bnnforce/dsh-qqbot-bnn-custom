/**
 * 42-strip-error-leaks — 把**运行时错误**从出站正文里清掉（防技术细节泄漏到群）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景（2026-11-24 群实测，Bnn 的猫群喵）：
 *
 *   模型回复里混进了一条原始错误，原样发到了群里：
 *
 *       FsError: FS_NOT_FOUND
 *
 *   紧接着才是正常回复「新游试玩呀……好玩的话我也想试试。」
 *
 *   群友看到的是："她怎么突然骂一句英文？" —— 比不回更糟。
 *
 * ── 为什么 40-strip-tool-leaks 没挡住 ──────────────────────────────────────
 *
 *   那个只清「使用 text_break」这类**工具名残渣**，
 *   完全不认错误码 / 堆栈 / 异常类名。
 *
 * ── 这类文本从哪来（三个已知来源）──────────────────────────────────────────
 *
 *   ① 模型把 tool 的 error 字段当成内容复述（toolErrorMode=friendly 之前的默认行为）
 *   ② 宿主在 context 里注入了工具失败摘要，模型照抄
 *   ③ DSH 内核把 FsError 之类塞进正文（FS_NOT_FOUND 是内核错误码，对应 HTTP 404）
 *
 * ── 做法 ──────────────────────────────────────────────────────────────────
 *
 *   出站前识别「看起来像错误」的**独立行**并删除：
 *     · `XxxError: CODE` / `XxxException: ...`
 *     · 裸错误码：`FS_NOT_FOUND` / `ENOENT` / `EACCES` / `ETIMEDOUT` 等
 *     · 堆栈行：`    at foo (bar.js:1:2)`
 *     · Node 内部路径：`node:internal/...`
 *
 *   **只删整行看起来是错误的**，不碰正文里正常提到"错误"两字的句子。
 *   删完若正文空 → annihilate（这条不发），避免发一条空白。
 *
 * ⚠️ 这是兜底，不是鼓励。真正的修法是让工具错误不进正文，
 *    见上游 1.13.21 的 toolErrorMode（群聊建议设为 silent）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const name = 'strip-error-leaks';

/** 错误码白名单（出现这些「像代码的裸词」就当错误行处理）。 */
const ERROR_CODES = [
  'FS_NOT_FOUND', 'NOT_FOUND', 'ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR',
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOSPC', 'EMFILE',
  'TOOL_TIMEOUT', 'ABORT_ERR', 'ERR_MODULE_NOT_FOUND', 'ERR_INVALID_ARG',
];

/**
 * 一行是否"看起来是错误"。
 * 判据要严：宁可漏删，也不要把正常句子误杀。
 */
export function looksLikeErrorLine(line) {
  let t = String(line ?? '').trim();
  if (!t) return false;

  // ⓿ ★ 关键（2026-11-24 实测踩到）：先去掉 markdown 包装再判。
  //   群里实际泄漏的是 "`FsError: FS_NOT_FOUND`"（带反引号的代码格式），
  //   第一版没处理 ⇒ 所有判据落空、一行都没拦住。
  t = t
    .replace(/^`{1,3}\s*/, '')
    .replace(/\s*`{1,3}$/, '')
    .replace(/^\*\*\s*/, '')
    .replace(/\s*\*\*$/, '')
    .replace(/^>\s*/, '')
    .trim();
  if (!t) return false;

  // ① 异常类名 + 冒号：FsError: / TypeError: / Error: …
  if (/^[A-Z][A-Za-z0-9_]*(?:Error|Exception)\s*:/.test(t)) return true;

  // ② 裸错误码（允许夹在句子中间，宁可多拦也别放过）
  if (ERROR_CODES.some((c) => t.includes(c))) return true;

  // ③ 堆栈行
  if (/^\s*at\s+.+\(.+:\d+:\d+\)\s*$/.test(t)) return true;
  if (/^node:internal\//.test(t)) return true;

  // ④ Node 报错常见开头（带 code 的）
  if (/^code:\s*'?[A-Z_]{4,}'?$/.test(t)) return true;

  return false;
}

/**
 * 清理正文：按行过滤。
 *
 * @param {string} text
 * @returns {{ text: string, removed: number }}
 */
export function stripErrorLeaks(text) {
  const raw = String(text ?? '');
  if (!raw) return { text: raw, removed: 0 };

  const lines = raw.split('\n');
  const kept = [];
  let removed = 0;

  for (const line of lines) {
    if (looksLikeErrorLine(line)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }

  if (!removed) return { text: raw, removed: 0 };

  // 删完可能留下连续空行，压成一个；首尾空行去掉
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  return { text: out, removed };
}

export default async function onOutbound(ctx, next) {
  try {
    const rawIn = String(ctx?.text ?? '');
    if (!rawIn) return next();

    const { text, removed } = stripErrorLeaks(rawIn);
    if (!removed) return next();

    // 全删光 ⇒ 这条不发（否则群里收到一条空白）
    if (!text.trim()) {
      try { ctx.annihilate?.('正文全是错误信息，已拦截'); } catch { /* ignore */ }
      return;
    }

    try { ctx.rewrite?.(text); } catch { /* ignore */ }
    try { ctx.note?.(`已清掉 ${removed} 行错误信息`); } catch { /* ignore */ }
    return next();
  } catch {
    // 兜底：清理逻辑本身出错也绝不影响发送
    return next();
  }
}
