/**
 * slang-harvest-task — 梗的自动发现定时任务（R8 S9，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个 hook：
 *
 *   `lib/slang/harvest.mjs` 的纯函数早就写好了（harvest / writeCandidates），
 *   但**没有任何定时任务调用它** ⇒ 候选.md 永远不会产生。
 *   实测：黑话本只有 1 个群 6 条，候选.md 从没存在过。
 *
 *   本 hook 把「每天扫一遍群聊 → 找候选梗 → 写候选.md」接上。
 *
 * ── 铁律（不可违反）────────────────────────────────────────────────────────
 *
 *   ⚠️ **只写候选.md，绝不写黑话.md**
 *
 *   自动收词会把「哈哈哈」「笑死」这类噪声全收进去。
 *   黑话.md 是**已人工确认**的权威数据，只有主人能改。
 *   本 hook 只负责「提出候选」，不负责「采纳」。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { harvest, writeCandidates, readKnownWords } from '../lib/slang/harvest.mjs';

const name = 'slang-harvest-task';

/** 每天跑一次（低峰）。 */
const FALLBACK_MS = 24 * 3600_000;

/** 回看最近几天（当天 + 近 3 天，覆盖跨日对话）。 */
const LOOKBACK_DAYS = 4;

function diag(event, data = {}) {
  try {
    const file = join(EXT_DATA, 'slang-harvest.log');
    mkdirSync(EXT_DATA, { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 列出所有有存档的群（裸 gid）。 */
function listGroups() {
  const root = join(EXT_DATA, 'msg-archive');
  try {
    return readdirSync(root)
      .filter((d) => d.startsWith('group_'))
      .map((d) => d.replace(/^group_/, ''));
  } catch {
    return [];
  }
}

/**
 * 读某群最近 N 天的存档消息。
 *
 * @param {string} gid 裸 gid
 * @param {number} days
 * @returns {Array<{s:string, x:string, t:number}>}
 */
export function readRecentMessages(gid, days = LOOKBACK_DAYS) {
  const dir = join(EXT_DATA, 'msg-archive', `group_${gid}`);
  if (!existsSync(dir)) return [];

  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(-days);
  } catch { return []; }

  const out = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          const text = String(j?.x ?? '');
          const sender = String(j?.s ?? '');
          if (!text || !sender) continue;
          out.push({ s: sender, x: text, t: Number(j?.t) || 0 });
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

export async function run(env) {
  const tick = async () => {
    try {
      const groups = listGroups();
      if (!groups.length) {
        diag('skip', { reason: 'no-archive' });
        return;
      }

      let totalFound = 0;
      let totalWritten = 0;
      const detail = [];

      for (const gid of groups) {
        try {
          const messages = readRecentMessages(gid, LOOKBACK_DAYS);
          if (messages.length < 10) {
            // 消息太少，找不出有意义的候选
            detail.push({ gid: gid.slice(0, 8), msgs: messages.length, found: 0, skip: 'too-few' });
            continue;
          }

          // ★ 复用已有纯函数：harvest 只算，writeCandidates 只写候选.md
          const known = readKnownWords(gid);
          const candidates = harvest(messages, known);

          if (!candidates.length) {
            detail.push({ gid: gid.slice(0, 8), msgs: messages.length, found: 0 });
            continue;
          }

          // ⚠️ 这里只调 writeCandidates（写 候选.md），绝不碰 黑话.md
          const ok = writeCandidates(gid, candidates);
          totalFound += candidates.length;
          if (ok) totalWritten += 1;

          detail.push({
            gid: gid.slice(0, 8),
            msgs: messages.length,
            known: known.size,
            found: candidates.length,
            top: candidates.slice(0, 3).map((c) => `${c.word}(${c.count}次/${c.people}人)`),
            written: ok,
          });
        } catch (e) {
          diag('group-failed', { gid: gid.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
        }
      }

      diag('tick', {
        groups: groups.length,
        found: totalFound,
        written: totalWritten,
        detail,
      });
    } catch (e) {
      diag('failed', { err: e instanceof Error ? e.message : String(e) });
    }
  };

  // 启动即跑一次（重启后补上错过的）
  await tick();

  registerWithFallback('slang-harvest-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'slang-harvest-task', meta: { id: 'ext-slang-harvest' },
  });
}

export default { name, run };
