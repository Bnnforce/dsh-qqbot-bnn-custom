/**
 * 99-final-leak-check — 出站最后一道闸：统一拦截「不该给群友看的东西」
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这一层（而不是继续加专用 hook）
 *
 *   出站链已经有 11 个 hook，其中两个是"专门清某类泄漏"：
 *     · 40-strip-tool-leaks   → 清「使用 text_break」这类工具名残渣
 *     · 42-strip-error-leaks  → 清 FsError / 错误码 / 堆栈
 *
 *   问题是：**每出现一种新泄漏，就要新建一个 hook**。而泄漏形态是长尾的：
 *     · 绝对路径泄漏   /data/user/0/.../profiles/web/node_modules/...
 *     · 内部文件名     outbound/42-strip-error-leaks.mjs
 *     · 工具原始报错   ❌ 工具 web_fetch 执行失败 ToolTimeoutError: TOOL_TIMEOUT
 *     · 内部标识符     im-qqbot-2 / caps.appendWake / ctx.rewrite
 *
 *   所以加这**最后一道**：清单集中在一个地方，以后发现新形态就加一条规则，
 *   不再散着加 hook。
 *
 * ── 设计原则（重要，别改成激进过滤）────────────────────────────────────────
 *
 *   ① **只删"整行/整块明显是内部信息"的**，不删正文里正常提到相关词的句子
 *   ② **不确定就留**：宁可漏一条，也不要把正常回复砍掉
 *   ③ 清理后为空 → annihilate（不发空白消息）
 *   ④ 本 hook 自己出错 → 一律放行（绝不因为过滤逻辑 bug 导致所有消息发不出）
 *
 * ── 出口位置 ──────────────────────────────────────────────────────────────
 *
 *   文件名 `99-` 保证**最后执行**（上游按文件名升序装载）。
 *   前面的 hook 可以随意改写正文，这里是最终检查。
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const name = 'final-leak-check';

/**
 * 规则表：每条 { id, test, kind, why }
 *
 * kind = 'line'  → 只删命中的那一行
 * kind = 'inline' → 只删命中的片段（用于行内路径）
 *
 * ⚠️ 加规则前先问：会不会误杀正常句子？拿不准就加 kind='line'（更保守）。
 */
const RULES = [
  // ── 错误与异常 ──────────────────────────────────────────────────────────
  {
    id: 'error-class',
    kind: 'line',
    // FsError: / TypeError: / XXXException:
    test: (l) => /^[A-Z][A-Za-z0-9_]*(?:Error|Exception)\s*:/.test(l),
    why: '异常类名 + 冒号',
  },
  {
    id: 'error-code',
    kind: 'line',
    test: (l) =>
      /\b(?:FS_NOT_FOUND|ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOSPC|EMFILE|ERR_MODULE_NOT_FOUND|TOOL_TIMEOUT|ABORT_ERR)\b/.test(l),
    why: '裸系统错误码',
  },
  {
    id: 'stack-line',
    kind: 'line',
    test: (l) => /^\s*at\s+.+\(.+:\d+:\d+\)\s*$/.test(l) || /^node:internal\//.test(l),
    why: '堆栈行 / node 内部路径',
  },
  {
    id: 'tool-fail-banner',
    kind: 'line',
    // ❌ 工具 web_fetch 执行失败 ToolTimeoutError: TOOL_TIMEOUT
    test: (l) => /^❌?\s*工具\s+\S+\s+执行失败/.test(l),
    why: '工具失败横幅',
  },

  // ── 内部路径与标识 ──────────────────────────────────────────────────────
  {
    id: 'abs-path',
    kind: 'line',
    // 整行就是一个 /data/... 或 /storage/... 路径（正文里提到"看那个文件"不算）
    test: (l) => /^(?:\/data|\/storage|\/sdcard|\/system|\/apex)\/\S+$/.test(l),
    why: '绝对路径独占一行',
  },
  {
    id: 'node-modules-path',
    kind: 'inline',
    test: (s) => s.replace(/\/[^\s]*node_modules\/[^\s]*/g, ''),
    why: '行内 node_modules 路径',
  },
  {
    id: 'ext-file-path',
    kind: 'line',
    // outbound/42-strip-error-leaks.mjs 这种内部文件名独占一行
    test: (l) =>
      /^(?:outbound|inbound|hooks|tools|commands|botplay|lib)\/[\w.-]+\.(?:mjs|js|json)$/.test(l),
    why: '内部扩展文件名',
  },
  {
    id: 'internal-ident',
    kind: 'line',
    // im-qqbot-2 / caps.appendWake / ctx.rewrite / ctx.send
    test: (l) => /^(?:im-qqbot[\w-]*|caps\.[a-zA-Z]+|ctx\.[a-zA-Z]+)$/.test(l),
    why: '内部标识符独占一行',
  },
];

/**
 * 对一行应用所有规则。
 * @returns {{ drop: boolean, replaced: string, hits: string[] }}
 */
export function processLine(line) {
  const raw = String(line ?? '');
  let t = raw.trim();
  if (!t) return { drop: false, replaced: raw, hits: [] };

  // 去掉 markdown 包装再判（真机踩过：`FsError: FS_NOT_FOUND` 带反引号）
  const unwrapped = t
    .replace(/^`{1,3}\s*/, '')
    .replace(/\s*`{1,3}$/, '')
    .replace(/^\*\*\s*/, '')
    .replace(/\s*\*\*$/, '')
    .replace(/^>\s*/, '')
    .trim();

  const hits = [];
  for (const rule of RULES) {
    if (rule.kind === 'line' && rule.test(unwrapped)) {
      hits.push(rule.id);
    }
  }
  if (hits.length) return { drop: true, replaced: '', hits };

  // inline 规则：不删整行，只替换片段
  let out = raw;
  for (const rule of RULES) {
    if (rule.kind !== 'inline') continue;
    const next = rule.test(out);
    if (typeof next === 'string' && next !== out) {
      out = next;
      hits.push(rule.id);
    }
  }
  return { drop: false, replaced: out, hits };
}

/**
 * 清理整段正文。
 * @returns {{ text: string, dropped: number, hits: string[] }}
 */
export function finalLeakCheck(text) {
  const raw = String(text ?? '');
  if (!raw) return { text: raw, dropped: 0, hits: [] };

  const out = [];
  let dropped = 0;
  const allHits = new Set();

  for (const line of raw.split('\n')) {
    const r = processLine(line);
    if (r.drop) {
      dropped += 1;
      r.hits.forEach((h) => allHits.add(h));
      continue;
    }
    if (r.hits.length) r.hits.forEach((h) => allHits.add(h));
    out.push(r.replaced);
  }

  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  return { text: cleaned, dropped, hits: [...allHits] };
}

export default async function onOutbound(ctx, next) {
  try {
    const rawIn = String(ctx?.text ?? '');
    if (!rawIn) return next();

    const { text, dropped, hits } = finalLeakCheck(rawIn);
    if (!dropped && !hits.length) return next();

    // 全删光 ⇒ 不发（避免群里收到空白）
    if (!text.trim()) {
      try { ctx.annihilate?.(`正文全是内部信息（${hits.join(',')}），已拦截`); } catch { /* ignore */ }
      return;
    }

    try { ctx.rewrite?.(text); } catch { /* ignore */ }
    try { ctx.note?.(`final-leak-check: 拦截 ${hits.join(',')}`); } catch { /* ignore */ }
    return next();
  } catch {
    // 过滤逻辑自己出错 ⇒ 一律放行，绝不让所有消息发不出去
    return next();
  }
}
