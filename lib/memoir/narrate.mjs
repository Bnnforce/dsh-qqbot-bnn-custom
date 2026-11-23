/**
 * memoir/narrate — 把统计变成「她讲的故事」（R5.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 两种形态（方案 §2.1）
 *
 *   A. narrateTemplate —— 纯模板填空，**零 LLM、零 IO**
 *      LLM 不可用时的保底，保证功能「永远有输出」
 *
 *   B. narrateLlm —— 走宿主 LLM 做叙事
 *      失败返回 null（调用方自动退回 A）
 *
 *   narrate = 主入口：优先 B，失败退 A，都没数据返回空
 *
 * ── LLM 路径（已实证，不是猜的）────────────────────────────────────────
 *
 *   实测 `dist/features/ext-capabilities.js` 的能力包**没有 llm 键**，
 *   扩展侧唯一入口是 `kernel.get('llm')`（契约文档 extension-contract.md:124）。
 *
 *   而且我们已有现成适配器：`lib/shop/adapters/llm-host.mjs`
 *   （2026-11-17 落地，已封装「找服务 / 选模型 / 收流 / 超时 / 失败关闭」）。
 *   **直接复用，不重写**（铁律 1：别自己造）。
 *
 *   ⚠️ 实测约束（2026-10-13）：`kernel.get('llm')` 在 handler / 定时任务里能拿到，
 *      在**卡片按钮回调**里拿不到 —— 所以本模块只在命令 handler / 定时任务调用。
 *
 * ── 三条红线 ────────────────────────────────────────────────────────────
 *   ① 不报分数堆砌（说人话）
 *   ② 不含 openid、不复述他人原话
 *   ③ 失败绝不抛（降级到模板）
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EXT_DATA } from '../pack-paths.mjs';

/** 诊断日志文件（直写，绕过 logger 级别过滤 —— 排查时 logger 经常看不到）。 */
const DIAG_FILE = `${EXT_DATA}/memoir-diag.log`;

/**
 * A 形态：纯模板填空。
 *
 * @param {object} stats computeStats 输出
 * @param {{ personaName?:string, maxChars?:number }} [opts]
 * @returns {string} 空 stats → ''
 */
export function narrateTemplate(stats, opts = {}) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const total = Number(s.total) || 0;
  if (!total) return '';

  const days = Number(s.days) || 0;
  const people = Number(s.people) || 0;
  const peakHour = Number(s.peakHour) || 0;
  const peakCount = Array.isArray(s.hours) ? Number(s.hours[peakHour]) || 0 : 0;
  const maxChars = Math.max(50, Number(opts.maxChars) || 300);

  const parts = [];

  // 开头：总量
  parts.push(`这${days > 0 ? ` ${days} 天` : '阵子'}群里一共说了 ${total} 句话，${people} 个人参与。`);

  // 高峰
  if (peakCount > 0) {
    parts.push(`最热闹的是 ${peakHour} 点前后，那会儿有 ${peakCount} 条。`);
  }

  // 发言排行（只说前 3，避免念清单）
  const top = Array.isArray(s.topPeople) ? s.topPeople.slice(0, 3) : [];
  if (top.length) {
    const names = top.map((p) => p.name).join('、');
    parts.push(`说话最多的是 ${names}。`);
  }

  // 关键词（最多 4 个，呈现「聊什么」）
  const kws = Array.isArray(s.keywords) ? s.keywords.slice(0, 4).map((k) => k.word) : [];
  if (kws.length) {
    parts.push(`聊得比较多的有「${kws.join('」「')}」。`);
  }

  let text = parts.join('');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}

/**
 * 从 ctx / env 里找宿主 LLM 服务并包成 narrate 需要的接口。
 *
 * 复用 `lib/shop/adapters/llm-host.mjs`（已验证可用的标准实现），
 * 拿不到返回 null —— 调用方自动降级到模板。
 *
 * @param {{ ctx?:object, logger?:object }} opts
 * @returns {Promise<{stream:Function, listProviders?:Function, defaultRoute?:Function}|null>}
 */

/**
 * 主入口：只保留模板叙事。
 *
 * ★★ 2026-11-21 架构修正：**LLM 叙事已移除**。
 *
 *   原来这里是「命令 handler 自己调 kernel.get('llm')」，连修 6 轮仍不稳定
 *   （listProviders 形态 / cordis getter / listModels 联网挂死 / chunk 协议 /
 *     AbortSignal / 总超时），真机表现为「发命令没反应」或机械模板。
 *
 *   根因：方向错了。官方有 wake 机制（middleware-setup.js:659）——
 *   命令返回 { wake: { content } }，宿主把它当合成消息注入会话，
 *   AI 带着完整人格 + 历史 + 八维情绪自己生成回复。
 *   ⇒ LLM 调用是宿主的事。
 *
 *   本文件现在只保留 narrateTemplate（纯函数），供**测试**与离线场景使用。
 *   实际命令走 commands/回忆录.mjs 的 wake 路径。
 */
export async function narrate(stats, opts = {}) {
  const tpl = narrateTemplate(stats, opts);
  if (tpl) return { text: tpl, mode: 'template' };
  return { text: '', mode: 'empty' };
}

export default { narrateTemplate, narrate };
