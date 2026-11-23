/**
 * style-guard — 出站语气巡检（默认只告警，可选轻改写）
 *
 * 位置：outbound，文件名 50-，排在 strip-tool-leaks（40-）之后。
 * 原则：不硬删、不拦截、不改语义；只处理客服腔、句中换行、全角空格等格式问题。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';

export const name = 'style-guard';
const LOG_FILE = join(EXT_DATA, 'style-guard.jsonl');
const CONFIG_FILE = join(EXT_DATA, 'style-guard-config.json');
// 2026-11-01：`newline` 默认关闭 —— 拆分气泡上线后，正文换行是**期望形态**（split-bubbles 靠它分段），
// 再把它当风格问题告警只会把 style-guard.jsonl 刷满。需要告警时在 style-guard-config.json 里打开。
const DEFAULT_RULES = { kehu: true, newline: false, fullwidth_space: true, emoji: true, renjia: true, repeat: true };
const KEHU = ['亲', '为您', '请稍等', '还有什么可以帮您'];

function readConfig() {
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
    return {
      enabled: j.enabled !== false,
      rewrite: j.rewrite === true,
      rules: { ...DEFAULT_RULES, ...(j.rules || {}) },
    };
  } catch {
    return { enabled: true, rewrite: false, rules: { ...DEFAULT_RULES } };
  }
}
function logRow(row) {
  // 2026-11-01 审查 P2-6：日志轮转（>256KB 归一到 .1），避免无上限增长。
  appendLogRotating(LOG_FILE, JSON.stringify(row) + '\n', 256 * 1024);
}
function targetKey(ctx) {
  const t = ctx?.target ?? {};
  const scope = String(t.scope ?? ctx?.scope ?? '');
  const id = String(t.targetId ?? t.peerId ?? ctx?.peer?.peerId ?? '');
  return scope && id ? `${scope}:${id}` : '';
}
function countEmoji(s) {
  try { return ([...s].filter((ch) => /\p{Extended_Pictographic}/u.test(ch))).length; } catch { return 0; }
}
function hasCodeBlock(s) { return /```/.test(s); }
function stripMarkers(s) {
  return String(s ?? '')
    .replace(/\[MEDIA:[^\]]+\]/gi, '')
    .replace(/\[RECALL\]/gi, '')
    .replace(/\[rf:[^\]]+\]/gi, '')
    .replace(/<@[^>]+>/g, '');
}
function skipFormatRewrite(s) {
  // 不改代码块/引用块；遇到就不做“轻改写”，但仍告警
  return hasCodeBlock(s) || /(^|\n)\s*>/.test(s);
}

export default async function onOutbound(ctx, next) {
  try {
    const kind = String(ctx?.kind ?? 'text');
    if (kind !== 'text' && kind !== 'markdown') return next();
    const raw = String(ctx?.text ?? '');
    if (!raw.trim()) return next();
    const cfg = readConfig();
    if (!cfg.enabled) return next();

    const key = targetKey(ctx);
    const body = stripMarkers(raw);
    const rows = [];
    const add = (rule, note) => rows.push({
      timestamp: new Date().toISOString(), peer: key, rule,
      excerpt: raw.slice(0, 80), action: 'warn', note,
    });

    if (cfg.rules.kehu && KEHU.some((w) => body.includes(w))) add('kehu', '命中客服腔禁用词');
    if (cfg.rules.newline && /\n/.test(body)) add('newline', '正文含换行');
    if (cfg.rules.fullwidth_space && body.includes('\u3000')) add('fullwidth_space', '正文含全角空格');
    if (cfg.rules.emoji && countEmoji(body) > 1) add('emoji', `表情符号 ${countEmoji(body)} 个`);
    if (cfg.rules.renjia && (body.match(/人家/g) || []).length > 1) add('renjia', '「人家」超过 1 次');
    if ((body.match(/♡/g) || []).length > 1) add('heart', '♡ 超过 1 次');
    // ⚠️ 2026-11-15 修（真 bug，实测 417 次命中里 416 次是误报）：
    //   原来写 `(body.match(/…/g) || []).length > 1` —— 按**字符**数。但中文标准省略号「……」
    //   本身就是 **2 个 `…` 字符**，所以「用一次省略号」就必然 > 1 ⇒ 每条带「……」的回复都被判违规。
    //   实测台账：ellipsis 417 条，其中 416 条的 excerpt 只含**一处**省略号（字符数恰好 2）。
    //   改成按**处**数（连续 … 视为一处），阈值 2 处起告警，语义才与 `note` 文案「超过 1 次」一致。
    const ellipsisGroups = (body.match(/…+/g) || []).length;
    if (ellipsisGroups > 1) add('ellipsis', `省略号出现 ${ellipsisGroups} 处`);
    if (cfg.rules.repeat) {
      const parts = body.split(/[。！？!?；;\n]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
      const seen = new Set();
      for (const p of parts) {
        if (seen.has(p)) { add('repeat', '同句/同层意思重复'); break; }
        seen.add(p);
      }
    }

    if (rows.length) {
      for (const r of rows) logRow(r);
      // ⚠️ 出站 ctx 上**没有 `log`**（上游 makeOutboundCtx 只有 logger / note，见
      //   dist/features/ext-outbound.js:295 `logger`、:337 `note(msg)`）。旧写法 `ctx?.log?.warn?.()`
      //   因可选链恒为 no-op —— 告警从来没落过，还不报错，所以一直没人发现。
      //   统一走 logger（与 40/45 两个 hook 同口径）。
      try { ctx.logger?.warn?.(`[style-guard] ${rows.map((r) => r.rule).join(',')} | ${raw.slice(0, 60)}`); } catch { /* ignore */ }
    }

    // 只对 newline / fullwidth_space 做可选轻改写；其余一律只告警，不拦截
    let out = raw;
    let changed = false;
    if (cfg.rewrite && !skipFormatRewrite(raw)) {
      if (cfg.rules.fullwidth_space && out.includes('\u3000')) { out = out.replace(/\u3000/g, ' '); changed = true; }
      if (cfg.rules.newline && /\n/.test(out)) { out = out.replace(/\n+/g, ' '); changed = true; }
    }
    if (changed && out !== raw) {
      try { ctx.rewrite?.(out); } catch { /* ignore */ }
    }
  } catch { /* 任何异常都不影响发送 */ }
  return next();
}
