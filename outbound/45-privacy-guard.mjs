/**
 * privacy-guard — 出站隐私脱敏（确定性兜底，2026-11-01 主人要求）
 *
 * 背景：AI 手里有群友的聊天记录、引用图、群记忆与本地文件读取权限，群里完全可能在汇报
 * 这些内容时把手机号、身份证号、银行卡号、密码这类东西原样念出来。人设规则只能降低概率，
 * 这里再加一道**确定性**出站清洗：命中就替换成占位词，绝不把原文发到 QQ。
 * （2026-11-02 主人撤回 root 与虚拟屏权限后设备/屏幕能力已下线，本 hook 与设备能力无关，
 *  纯出站兜底，保持启用。）
 *
 * 覆盖（按命中顺序）：
 *   ① 身份证：18 位（末位可为 X）→ `[证件号已脱敏]`
 *   ② 手机号：1[3-9] 开头 11 位 → `[号码已脱敏]`
 *   ③ 银行卡：16–19 位连续数字 → `[卡号已脱敏]`
 *   ④ 邮箱 → `[邮箱已脱敏]`
 *   ⑤ 密码/口令/验证码/PIN 后跟的值（≥4 位可见字符）→ `$1：[已脱敏]`
 *
 * 设计纪律：
 *   - **只脱敏不拦截**：群聊被 @ 必回（P0M），把整条吞掉反而违反规则；替换后照常发。
 *   - **日志不落原文**：只记 cid/类别/条数，绝不落命中的数字（否则审计日志变成泄漏源）。
 *   - 宁可少匹配：手机/证件/卡号都有数字边界，避免误伤时间戳、序号、QQ 号。
 */
import { join } from 'node:path';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { appendLogRotating } from '../lib/log-rotate.mjs';

export const name = 'privacy-guard';

// 与 security-guard 同款：日志路径可被测试注入，避免 mock 往生产审计日志写。
const LOG = process.env.QQBOT_PRIVACY_LOG || join(EXT_DATA, 'privacy-guard.log');

/** 每条规则：[类别, 正则, 替换]；顺序有意义（先长后短）。 */
const RULES = [
  ['id-card', /(?<!\d)\d{17}[\dXx](?!\d)/g, '[证件号已脱敏]'],
  ['phone', /(?<!\d)1[3-9]\d{9}(?!\d)/g, '[号码已脱敏]'],
  ['bank-card', /(?<!\d)\d{16,19}(?!\d)/g, '[卡号已脱敏]'],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱已脱敏]'],
];

function targetKey(ctx) {
  const t = ctx?.target ?? {};
  const scope = String(t.scope ?? ctx?.scope ?? '');
  const id = String(t.targetId ?? t.peerId ?? ctx?.peer?.peerId ?? '');
  return scope && id ? `${scope}:${id}` : '';
}

function note(line) {
  appendLogRotating(LOG, `[${new Date().toISOString()}] ${line}\n`, 128 * 1024);
}

export default async function onOutbound(ctx, next) {
  try {
    // 只处理文本/markdown；图片、语音、文件等类型不在这里改（规则层禁止发含隐私的截图）。
    const kind = String(ctx?.kind ?? 'text');
    if (kind !== 'text' && kind !== 'markdown') return next();
    const raw = String(ctx?.text ?? '');
    if (!raw) return next();

    let text = raw;
    const hits = [];
    for (const [kind, re, replacement] of RULES) {
      text = text.replace(re, () => {
        hits.push(kind);
        return replacement;
      });
    }
    // 密码/口令/验证码：要保留关键词本身，用回调替换（函数形式的 replacement 不会展开 $1）。
    text = text.replace(/(密码|口令|验证码|PIN|pin)\s*[：:是为=]?\s*([A-Za-z0-9!@#$%^&*._-]{4,})/g, (_m, key) => {
      hits.push('secret');
      return `${key}：[已脱敏]`;
    });
    if (hits.length === 0) return next();

    // 只记类别与条数，绝不落原文
    const summary = Object.entries(hits.reduce((acc, k) => { acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}))
      .map(([k, n]) => `${k}×${n}`).join(',');
    try { note(`masked ${summary} to=${targetKey(ctx)}`); } catch { /* ignore */ }
    try { ctx.logger?.warn?.(`[privacy-guard] 出站已脱敏：${summary}`); } catch { /* ignore */ }

    // 出站 hook 的 rewrite 接受**字符串**（与 inbound 的 {text,reason} 形状不同，见 40-strip-tool-leaks）。
    let rewrote = false;
    try { if (typeof ctx.rewrite === 'function') { ctx.rewrite(text); rewrote = true; } } catch { /* fallthrough */ }
    if (!rewrote) { try { ctx.text = text; } catch { /* ignore */ } }
  } catch { /* 任何异常都放行原文本，不影响回复 */ }
  return next();
}
