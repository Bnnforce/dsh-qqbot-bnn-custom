/**
 * memory-gc-task — 记忆垃圾回收（R8 S4，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 每周跑一次，把超期的日志归档（**移动，不是删除**）。
 *
 *   为什么是「归档」不是「删除」：
 *     长期使用的风险是数据无限增长，但「清理脚本误删记忆」比增长严重得多。
 *     所以这里只做 mv，文件还在，只是换了个地方；每次还写 manifest 可回滚。
 *
 *   保留策略：
 *     · 生活流     30 天
 *     · 消息存档   365 天
 *
 *   ⚠️ 不碰核心数据：人物卡 / 群史事件 / 关系 / 黑话本 —— 一个都不动
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { runGc } from '../lib/memory/gc.mjs';

const name = 'memory-gc-task';

/** 每周一次（周日低峰）。 */
const FALLBACK_MS = 7 * 24 * 3600_000;

export async function run(env) {
  const tick = async () => {
    try {
      // 先 dry-run 看有多少要归档
      const preview = runGc({ dryRun: true });
      const total = preview.lifeStream.archived + preview.msgArchive.archived;

      // 没有可归档的就不真跑（避免无意义的 manifest）
      if (total === 0 && preview.orphans.count === 0) {
        return;
      }

      // 真跑
      const r = runGc({ dryRun: false });
      if (r.lifeStream.archived > 0 || r.msgArchive.archived > 0) {
        env?.logger?.info?.(
          `[memory-gc] 已归档 ${r.lifeStream.archived + r.msgArchive.archived} 个文件`
          + (r.manifest ? `（manifest: ${r.manifest.split('/').pop()}）` : ''),
        );
      }
    } catch (e) {
      try {
        env?.logger?.warn?.(`[memory-gc] 失败: ${e instanceof Error ? e.message : String(e)}`);
      } catch { /* ignore */ }
    }
  };

  // 启动即跑一次（重启后补上错过的）
  await tick();

  registerWithFallback('memory-gc-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'memory-gc-task', meta: { id: 'ext-memory-gc' },
  });
}

export default { name, run };
