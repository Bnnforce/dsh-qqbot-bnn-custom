/**
 * evolution-task — 人格演化轨迹（R7 Stage 4，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 每周日跑一次，累积人格演化指标。
 *
 *   ⚠️ 这是**长期功能**：现在只有几天的数据，看不出趋势。
 *      必须静默积累，3 个月后才有意义。所以本 hook 不主动推送任何东西。
 *
 *   ⚠️ 只读呈现：绝不改角色卡。人格是用户唯一能确定的东西。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { join } from 'node:path';

import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA, DATA_ROOT } from '../lib/pack-paths.mjs';
import { styleMetrics, moodMetrics, deltaOf, isSignificant, detectMilestones } from '../lib/persona-evolution/metrics.mjs';
import { writeJsonAtomic, readJsonSafe } from '../lib/pure/atomic.mjs';

const name = 'evolution-task';

/** 每周一次（周日低峰）。 */
const FALLBACK_MS = 7 * 24 * 3600_000;

/** 指标累积文件（每行一次快照）。 */
const METRICS_FILE = join(EXT_DATA, 'persona-evolution', 'metrics.jsonl');

/** 里程碑文件。 */
const MILESTONES_FILE = join(EXT_DATA, 'persona-evolution', 'milestones.json');

/** 情绪历史目录（插件写，我们只读）。 */
const MOOD_DIR = '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/data/dsh-anti-ai-persona/state/mood-history';

function diag(event, data = {}) {
  try {
    const file = join(EXT_DATA, 'evolution-diag.log');
    mkdirSync(EXT_DATA, { recursive: true });
    appendLogRotating(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 读情绪历史快照（最近 N 天）。 */
function readMoodSnapshots(days = 30) {
  try {
    const files = readdirSync(MOOD_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .slice(-days);
    const out = [];
    for (const f of files) {
      try { out.push(JSON.parse(readFileSync(join(MOOD_DIR, f), 'utf8'))); } catch { /* 跳过坏文件 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** 读上次累积的指标。 */
function readMetrics() {
  if (!existsSync(METRICS_FILE)) return [];
  try {
    const raw = readFileSync(METRICS_FILE, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch { return []; }
}

/**
 * 从 msg-history 采集「她自己的」消息（s === self）。
 *
 * ★ 2026-11-26 再修（R7 修复被回退了）：
 *   原来传 styleMetrics([]) 空数组，指标恒为 samples=0，
 *   等于说话方式这一维从来没算过。实际 msg-history 里 self 消息有几百条。
 */
function collectSelfMessages(days = 30) {
  const out = [];
  try {
    const root = join(DATA_ROOT, '.qqbot', 'msg-history');
    let dirs = [];
    try { dirs = readdirSync(root).filter((d) => d.startsWith('group_')); } catch { return out; }
    for (const d of dirs) {
      let files = [];
      try { files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl')).sort().slice(-days); } catch { continue; }
      for (const f of files) {
        try {
          const raw = readFileSync(join(root, d, f), 'utf8');
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
              const j = JSON.parse(line);
              if (j && j.s === 'self') out.push({ text: String(j.x ?? '') });
            } catch { /* 跳过坏行 */ }
          }
        } catch { /* 跳过坏文件 */ }
      }
    }
  } catch { /* 无 msg-history */ }
  return out;
}

export async function run(env) {
  const tick = async () => {
    try {
      const now = Date.now();

      // ① 情绪基线
      const snapshots = readMoodSnapshots(30);
      const mood = moodMetrics(snapshots);

      // ② 说话方式（从出站消息算，暂用空数组占位——需要出站消息源）
      //    这里先只算情绪，说话方式等有数据源再接。
      // 真实采集她自己的消息（原来传空数组，指标恒为 0）
      const selfMsgs = collectSelfMessages(30);
      const style = styleMetrics(selfMsgs);

      const snapshot = {
        at: now,
        period: ymdOf(now),
        style,
        mood,
        social: { proactiveCount: 0, replyCount: 0, samples: 0 },
      };

      // ③ 追加到指标文件
      try {
        mkdirSync(join(EXT_DATA, 'persona-evolution'), { recursive: true });
        // ⚠️ 指标快照是**数据**不是日志，绝不能轮转（轮转会丢历史）
        appendFileSync(METRICS_FILE, JSON.stringify(snapshot) + '\n', 'utf8');
      } catch (e) {
        diag('write-failed', { err: e instanceof Error ? e.message : String(e) });
        return;
      }

      // ④ 里程碑检测
      const history = readMetrics();
      const milestones = readJsonSafe(MILESTONES_FILE, { hits: [] }) || { hits: [] };
      const known = new Set(milestones.hits || []);
      const fresh = detectMilestones(history).filter((id) => !known.has(id));
      if (fresh.length) {
        milestones.hits = [...known, ...fresh];
        milestones.updatedAt = now;
        writeJsonAtomic(MILESTONES_FILE, milestones);
        diag('milestones', { added: fresh });
      }

      // ⑤ 变化显著性（只记日志，不推送）
      if (history.length >= 2) {
        const delta = deltaOf(history[0], snapshot);
        if (isSignificant(delta)) diag('significant-change', { delta });
      }

      diag('tick', { snapshots: snapshots.length, moodSamples: mood.samples });
    } catch (e) {
      diag('failed', { err: e instanceof Error ? e.message : String(e) });
    }
  };

  await tick();

  registerWithFallback('evolution-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'evolution-task', meta: { id: 'ext-evolution' },
  });
}

function ymdOf(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default { name, run };
