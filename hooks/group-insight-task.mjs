/**
 * group-insight-task — 群聊理解每日任务（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 每天跑一次：读所有群的近 3 天消息 → 清洗 → 话题 → 氛围 → 落盘。
 *
 * 纯算法，不用 LLM（成本可控）。
 * 失败关闭：任何异常只记日志，绝不影响主链。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { detectTopics } from '../lib/group-insight/topic.mjs';
import { computeAtmosphere } from '../lib/group-insight/atmosphere.mjs';
import { readRecentMessages, writeTopics, writeAtmosphere, listGroups } from '../lib/group-insight/store.mjs';

const name = 'group-insight-task';

/** 每天一次。 */
const FALLBACK_MS = 24 * 3600_000;

/** 话题识别窗口（天）。 */
const WINDOW_DAYS = 3;

function diag(event, data = {}) {
  try {
    const file = join(EXT_DATA, 'group-insight.log');
    mkdirSync(EXT_DATA, { recursive: true });
    appendLogRotating(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

export async function run(env) {
  const tick = async () => {
    try {
      const gids = listGroups();
      if (!gids.length) {
        diag('skip', { reason: 'no-groups' });
        return;
      }

      const today = new Date().toISOString().slice(0, 10);
      let processed = 0;
      let topicGroups = 0;

      for (const gid of gids) {
        try {
          // ① 读近 3 天消息
          const messages = readRecentMessages(gid, WINDOW_DAYS);
          if (messages.length < 10) continue;   // 太少不分析

          // ② 话题
          const { topics } = detectTopics(messages);
          if (topics.length) {
            writeTopics(gid, today, topics);
            topicGroups += 1;
          }

          // ③ 氛围
          const atmo = computeAtmosphere(messages);
          writeAtmosphere(gid, atmo, today);

          processed += 1;
          diag('group-done', { gid: gid.slice(0, 8), msgs: messages.length, topics: topics.length });
        } catch (e) {
          diag('group-failed', { gid: gid.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
        }
      }

      diag('tick', { groups: gids.length, processed, topicGroups, date: today });
    } catch (e) {
      diag('failed', { err: e instanceof Error ? e.message : String(e) });
    }
  };

  await tick();

  registerWithFallback('group-insight-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'group-insight-task', meta: { id: 'ext-group-insight' },
  });
}

export default { name, run };
