/**
 * diary/group-history — 读本群今日聊天记录（隔离 + 脱敏）（R6.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 核心职责（两条硬约束，缺一不可）：
 *
 *   ① **群隔离**：只读 `{dataRoot}/.qqbot/msg-history/group_<gid>/<date>.jsonl`，
 *      绝不读别的群的目录。
 *
 *   ② **脱敏**：日记「谁都能看」，所以喂 LLM 前必须：
 *       · openid / msgId 直接剔除（不出现在 prompt 里）
 *       · 群友昵称 → 「有人 / 大家 / 他 / 她」代指
 *       · 机器人自己（s==='self'）→ 「我」
 *       · 图片/媒体 → 一句「有人发了张图」，不展开内容
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么脱敏要在「读」这一步做，而不是「写日记」后做：
 *
 *   日记正文是 LLM 生成的，已经不含 openid（prompt 铁律里有）。
 *   但如果 prompt 里带了 openid，LLM 可能照抄进正文 —— 那就是泄漏。
 *   所以必须在**喂进去之前**就脱敏，从源头掐断。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 群历史目录。 */
function historyDir(dataRoot, gid) {
  return join(String(dataRoot ?? '').trim(), '.qqbot', 'msg-history', `group_${gid}`);
}

/** 读取某群某天的原始 jsonl 行（数组）。失败返回 []。 */
function readRawLines(dataRoot, gid, date) {
  try {
    const p = join(historyDir(dataRoot, gid), `${date}.jsonl`);
    if (!existsSync(p)) return [];
    const text = readFileSync(p, 'utf8');
    return text.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** 去掉 @提及 和零宽字符，压成一行干净文本。 */
function cleanText(raw) {
  return String(raw ?? '')
    .replace(/<@[^>]+>/g, '')
    .replace(/@[^\s]+/g, '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 读本群某天的聊天，脱敏成「事件列表」（供 LLM prompt 用）。
 *
 * @param {string} dataRoot
 * @param {string} gid       群 id
 * @param {string} date      YYYY-MM-DD
 * @param {object} [opts]
 * @param {number} [opts.maxEvents] 最多取多少条（防 prompt 过长，默认 60）
 * @returns {string[]} 形如 `[我] 回了：...`、`[有人] 说：...` 的事件列表
 */
export function readGroupEvents(dataRoot, gid, date, opts = {}) {
  const lines = readRawLines(dataRoot, gid, date);
  if (!lines.length) return [];

  const maxEvents = Math.max(1, Math.min(200, Number(opts.maxEvents) || 60));
  const events = [];

  for (const line of lines) {
    if (events.length >= maxEvents) break;
    let j;
    try { j = JSON.parse(line); } catch { continue; }

    const kind = String(j?.k ?? '');
    const sender = String(j?.s ?? '');
    const text = cleanText(j?.x);

    // 只保留 text 类消息（图片/媒体跳过，或概括一句）
    if (kind !== 'text') {
      if (kind === 'image') events.push('[有人] 发了张图片');
      continue;
    }
    if (!text) continue;

    // 过滤斜杠命令（/签到 /抽奖 这类是机器指令，不是聊天内容，不该进日记）
    if (/^[\/／]/.test(text)) continue;

    if (sender === 'self' || sender === 'robot') {
      events.push(`[我] 说：${text}`);
    } else {
      events.push(`[有人] 说：${text}`);
    }
  }

  return events;
}

export default { readGroupEvents };
