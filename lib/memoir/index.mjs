/**
 * memoir/index — 群回忆录编排层（R5.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 职责（只做编排，不做算法）
 *
 *   读历史文件 → cleanRows → computeStats → narrate → 返回结果
 *
 * 算法都在 clean.mjs / stats.mjs / narrate.mjs（纯函数，可独立测）。
 * 本文件是唯一有 IO 的地方，**所有 IO 都必须 try-catch 降级**。
 *
 * ── 数据源 ──────────────────────────────────────────────────────────────
 *
 *   {dataRoot}/.qqbot/msg-history/group_<gid>/<YYYY-MM-DD>.jsonl
 *   每行：{"id","s","n","t","k","x","me"?,"f"?}
 *
 *   由官方 `msg-history.ts` 维护（默认保留 7 天）。
 *   官方有 `readMsgHistory()` API，但那是**插件内部 API，扩展调不到**
 *   ⇒ 我们直接读文件（`tools/group_history.mjs` 已验证可行，复用同一路径口径）。
 *
 * ── 返回值 ──────────────────────────────────────────────────────────────
 *
 *   永不抛。失败返回 `{ok:false, reason}`，调用方按 reason 决定提示文案。
 *
 *   reason 取值：
 *     'DISABLED'   功能关闭
 *     'NO_DATA'    没有历史目录 / 没有消息
 *     'TOO_FEW'    消息数 < minMessages
 *     'ERROR'      其他异常
 *
 * ── 红线 ────────────────────────────────────────────────────────────────
 *   ① 只读历史，**绝不写/改/删**任何历史文件
 *   ② 不写任何记忆（不污染对话上下文）
 *   ③ 输出不含 openid、不复述他人原话
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanRows } from './clean.mjs';
import { computeStats } from './stats.mjs';
// ★ 2026-11-21：不再自己叙事（LLM 交给宿主的 wake 机制），narrate.mjs 仅保留模板能力供测试
import { readConfig } from './config.mjs';

/** 单日文件读取行数上限（防御：防超大文件吃内存）。 */
const MAX_LINES_PER_DAY = 5000;

/**
 * 历史目录。
 *
 * @param {string} dataRoot
 * @param {string} groupId
 * @returns {string}
 */
export function historyDirOf(dataRoot, groupId) {
  const root = String(dataRoot ?? '').trim();
  const gid = String(groupId ?? '').trim();
  if (!root || !gid) return '';
  return join(root, '.qqbot', 'msg-history', `group_${gid}`);
}

/**
 * 取最近 N 天的日期文件名（YYYY-MM-DD，按上海时区）。
 *
 * @param {number} days
 * @param {number} [now]
 * @param {string} [tz]
 * @returns {string[]} 从旧到新
 */
export function recentDayKeys(days, now = Date.now(), tz = 'Asia/Shanghai') {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const ts = now - i * 86400000;
    try {
      const s = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(ts));
      out.push(s);
    } catch {
      out.push(new Date(ts).toISOString().slice(0, 10));
    }
  }
  return out;
}

/**
 * 读取若干天的历史消息。
 *
 * @param {string} dir
 * @param {string[]} dayKeys
 * @returns {Array<object>} 原始消息行（未清洗）
 */
function readHistoryRows(dir, dayKeys) {
  const rows = [];
  if (!dir || !existsSync(dir)) return rows;

  for (const day of dayKeys) {
    const file = join(dir, `${day}.jsonl`);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      let n = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (n++ >= MAX_LINES_PER_DAY) break;
        try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
      }
    } catch { /* 单日读失败不影响其他天 */ }
  }
  return rows;
}

/**
 * 列出历史目录里实际存在的日期文件（用于日志/诊断）。
 *
 * @param {string} dir
 * @returns {string[]} YYYY-MM-DD，升序
 */
export function listAvailableDays(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace(/\.jsonl$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 生成群回忆录。
 *
 * @param {string} dataRoot qqbot 数据根（如 /…/Bot/dshqqbot）
 * @param {string} groupId 群 openid
 * @param {{ logger?:object, ctx?:object, config?:object, now?:number }} [opts]
 * @returns {Promise<{
 *   ok:boolean, reason?:string, text?:string,
 *   mode?:'llm'|'template',
 *   stats?:object,
 *   rawCount?:number, cleanCount?:number, daysUsed?:number
 * }>}
 */
export async function buildMemoir(dataRoot, groupId, opts = {}) {
  const logger = opts.logger;

  /** 统一失败返回。 */
  const fail = (reason, extra = {}) => {
    try { logger?.warn?.(`[memoir] 生成失败: ${reason}`); } catch { /* ignore */ }
    return { ok: false, reason, ...extra };
  };

  try {
    // ① 配置
    const cfg = opts.config && typeof opts.config === 'object'
      ? { ...readConfig({ logger }), ...opts.config }
      : readConfig({ logger });

    if (cfg.enabled !== true) return fail('DISABLED');

    const gid = String(groupId ?? '').trim();
    const root = String(dataRoot ?? '').trim();
    if (!root || !gid) return fail('NO_DATA', { detail: 'dataRoot/groupId 为空' });

    // ② 定位数据
    const dir = historyDirOf(root, gid);
    const now = Number(opts.now) || Date.now();
    const dayKeys = recentDayKeys(cfg.days, now, cfg.tz);
    const rawRows = readHistoryRows(dir, dayKeys);

    if (!rawRows.length) return fail('NO_DATA', { rawCount: 0 });

    // ③ 清洗（跳过她自己 + 非文本 + 纯噪声）
    const cleaned = cleanRows(rawRows);

    // ④ 量太少不生成（避免空群尴尬）
    if (cleaned.length < cfg.minMessages) {
      return fail('TOO_FEW', { rawCount: rawRows.length, cleanCount: cleaned.length, minMessages: cfg.minMessages });
    }

    // ⑤ 统计
    const stats = computeStats(cleaned, {
      topPeople: cfg.topPeople,
      topKeywords: cfg.maxKeywords,
      tz: cfg.tz,
    });

    // ⑥ 不再自己叙事 —— 只把统计结果交回去
    //
    //   ★★ 2026-11-21 架构修正：**删掉这里的 LLM 调用**。
    //
    //   原因：官方有 `wake` 机制（middleware-setup.js:659）——
    //   命令返回 { wake: { content } } 后，宿主把内容当合成消息注入会话，
    //   AI 带着**完整人格 + 历史 + 八维情绪注入**自己生成回复。
    //   ⇒ LLM 调用、人格、上下文预算全是宿主的事，扩展不需要也不应该自己调模型。
    //
    //   之前自己调 kernel.get('llm') 连修 6 轮仍不稳定（探测挂死/路由拿不到），
    //   根因就是方向错了。现在本模块只负责「算事实」，叙事交给 AI。
    const daysUsed = stats.days || listAvailableDays(dir).length;

    try {
      logger?.info?.(`[memoir] 统计完成 ${stats.total} 条 / ${daysUsed} 天（叙事交给 AI）`);
    } catch { /* ignore */ }

    return {
      ok: true,
      stats,
      rawCount: rawRows.length,
      cleanCount: cleaned.length,
      daysUsed,
    };
  } catch (e) {
    return fail('ERROR', { detail: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * 失败原因 → 给用户的友好提示。
 *
 * @param {string} reason
 * @param {object} [info] buildMemoir 的返回（含 minMessages 等）
 * @returns {string}
 */
export function reasonText(reason, info = {}) {
  switch (String(reason)) {
    case 'DISABLED':
      return '回忆录功能已关闭。';
    case 'NO_DATA':
      return '这个群还没有聊天记录，暂时没什么好回忆的呢。';
    case 'TOO_FEW':
      return `这几天的记录太少了（有效 ${Number(info.cleanCount) || 0} 条，至少要 ${Number(info.minMessages) || 30} 条），过阵子再来看吧。`;
    case 'ERROR':
    default:
      return '回忆录暂时生成不出来，等会儿再试试？';
  }
}

export default { buildMemoir, historyDirOf, recentDayKeys, listAvailableDays, reasonText };
