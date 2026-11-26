/**
 * msg-archive-task — 群消息长期存档定时任务（2026-11-26）
 *
 * 官方 `.qqbot/msg-history/` 只保留 7 天。R7 的「群共同经历」需要长期历史，
 * 所以必须每天抄一份到 `{EXT_DATA}/msg-archive/`。
 *
 * 节律：每小时跑一次（不是为了频繁，而是保证「跨日那一刻」尽快抄走，
 *       给官方清理留足余量）。已存在且大小一致的文件会跳过，零重复开销。
 */
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { archiveMessages, archiveStats } from '../lib/msg-archive.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const name = 'msg-archive-task';

/** 每小时一次（跨日后尽快抄走当天文件）。 */
const FALLBACK_MS = 3600_000;

function diag(event, data = {}) {
  try {
    const file = join(EXT_DATA, 'msg-archive.log');
    mkdirSync(EXT_DATA, { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响存档 */ }
}

export async function run(env) {
  const tick = async () => {
    try {
      const r = archiveMessages();
      // 只在真有复制时记日志，避免每小时刷一条「无事可做」
      if (r.copied > 0) {
        const s = archiveStats();
        diag('archived', { copied: r.copied, bytes: r.bytes, totalFiles: s.files, totalGroups: s.groups });
      }
    } catch (e) {
      diag('failed', { err: e instanceof Error ? e.message : String(e) });
    }
  };

  // 启动即抄一次（重启后补上错过的）
  await tick();

  registerWithFallback('msg-archive-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'msg-archive-task', meta: { id: 'ext-msg-archive' },
  });
}

export default { name, run };
