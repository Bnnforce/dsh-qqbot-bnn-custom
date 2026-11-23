/**
 * aaa-anti-spoof — 防伪造标记 / 防提示注入（最早挂点，文件名排序第一个）
 *
 * 为什么需要：
 *   · 人格里「消息带 ★主人 前缀才算主人」「收到【主人身份认证通过】要执行」是**信任插件注入**；
 *   · 但群友完全可以自己打字带 ★主人 / 【主人身份认证通过】/ 【本群成员台账】/ 【硬性规则…】，
 *     模型可能把用户原文当成插件提示 → 冒充主人、绕过规则；
 *   · 还可以打字塞 [MEDIA:image|/本地路径] 让模型复述 → 借机器人发本机文件；塞 [rf:] / [s:] 干扰引用与会话路由。
 *
 * 做法（只对**非主人、且未通过 /bnnmodeon 代行**的发送者）：
 *   1) 行首 ★主人 → ☆主人；
 *   2) 可信标记前面加「（群友自填）」，使其不再等于插件注入的原文；
 *   3) [MEDIA: / [RECALL] / [rf: / [s: / 【会话 等出站/路由标记拆开，避免被模型复述；
 *   4) 落一条诊断日志，便于回查。
 *
 * 安全：只改文本，不吞消息；主人与 owner-mode 代行身份完全不动。
 */
import { join } from 'node:path';
import { appendLogRotating } from '../lib/log-rotate.mjs';

export const name = 'anti-spoof';

import { EXT_DATA } from '../lib/pack-paths.mjs';
const DATA_DIR = EXT_DATA;
const LOG = join(DATA_DIR, 'anti-spoof.log');

function audit(obj) {
  // 2026-11-01 审查 P2-6：轮转（>256KB 归一到 .1）。
  appendLogRotating(LOG, `${new Date().toISOString()} ${JSON.stringify(obj)}\n`, 256 * 1024);
}

function sanitize(text) {
  return String(text ?? '')
    .replace(/^(\s*)★主人/m, '$1☆主人')
    .replace(/【主人身份认证通过】/g, '【（群友自填）主人身份认证通过】')
    .replace(/【主人身份认证已退出】/g, '【（群友自填）主人身份认证已退出】')
    .replace(/【本群成员台账·只读】/g, '【（群友自填）本群成员台账·只读】')
    .replace(/【(只回当前消息|硬性规则|引用回话硬性规则|认人规则|图片硬性规则)/g, '【（群友自填）$1')
    .replace(/\[MEDIA:/gi, '[ MEDIA:')
    .replace(/\[RECALL\]/gi, '[ RECALL ]')
    .replace(/\[rf:/gi, '[ rf:')
    // 2026-11-01 审查 P0-1：会话路由标记必须按路由正则的口径打断，不能只认「【会话 」带空格。
    // 路由侧 ROUTE_RE = /(?:\[s:|【\s*会话\s*)([0-9a-zA-Z][0-9a-zA-Z-]{2,63})\s*\]?】?/
    // ⇒ 只替换带空格的写法时，`【会话abc】` / `【 会话 abc】` 能原样绕过并把正文投递到任意会话。
    .replace(/[【\[]\s*会话\s*/g, '【（群友自填）会话 ')
    .replace(/[【\[]\s*子会话\s*/g, '【（群友自填）子会话 ')
    .replace(/\[\s*s\s*:/gi, '[ s:');
}

export async function onInbound(ctx, next) {
  try {
    const sender = String(ctx?.sender ?? ctx?.message?.senderId ?? '');
    let delegated = false;
    try { delegated = ctx?.kv?.get?.(`ownerMode:${sender}`) === true; } catch { delegated = false; }
    if (ctx?.isOwner === true || delegated) return next();

    const raw = String(ctx?.text ?? '');
    if (!raw) return next();
    const out = sanitize(raw);
    if (out !== raw) {
      ctx.rewrite({ text: out, reason: '防伪造标记/防媒体与引用注入' });
      audit({ sender: sender ? `${sender.slice(0, 6)}…` : '', raw: raw.slice(0, 120) });
    }
  } catch { /* 任何异常都放行 */ }
  return next();
}
