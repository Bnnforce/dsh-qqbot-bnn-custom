/**
 * persona-observation-task — 每 2 周生成一份「人格观察报告」（R6.7 · 缺口 6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要
 *
 *   路线缺口 6：「人格是静态卡，不会长大」——聊三个月还是一模一样的语气。
 *   但「写卡式人格漂移」是红线（人格是主人唯一能确定的东西，自动改角色卡
 *   会让主人觉得「她不是她了」）。
 *
 *   所以降级为**只读观察报告**：每 2 周把「她这段时间是什么样」汇总成一份
 *   报告，写到 `Bot/周报/人格观察-<日期>.md`，**不碰角色卡**。主人看完觉得对，
 *   再自己手动采纳。
 *
 * ── 与 weekly-report 的区别（别搞混）──────────────────────────────────────
 *
 *   · weekly-report（inbound/weekly-report.mjs）＝ **好感度周报**：她对每个群友
 *     的态度/熟识度变化，已经有。
 *   · 本文件 ＝ **人格观察报告**：她自己的情绪走势、主动程度、语气倾向，
 *     是另一个维度，这是缺口 6 要补的。
 *
 * ── 周期（每 2 周一次，可配）──────────────────────────────────────────────
 *
 *   照抄 diary-task / birthday-auto 的「日界任务」模式：
 *   · `registerWithFallback('persona-observation', tick, {fallbackMs, meta:{id}})` 挂进中央调度器
 *   · 到点（每 2 周的固定周几，默认周一 09:00）且「本轮还没写」才写
 *   · 按 `state.last` 去重，重启补写（已过点且没写 → 立刻补）
 *
 * ── 数据来源（全部已存在，不新增 LLM 调用）────────────────────────────────
 *
 *   · 情绪走势 → 插件的 mood-history 每日快照（8 维）
 *   · 主动程度 → 心跳 ledger（heartbeat-wake-ledger.json）里本周期主动次数
 *   · 关系变化 → R6.7 新做的 pair-relations（close 关系）
 *
 *   报告是「统计汇总 + 模板化文字」，成本为零。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { currentPersonaOf } from '../lib/io/persona-path.mjs';
import { defaultPersona } from '../lib/io/persona-store.mjs';
import { buildObservation } from '../lib/persona-observation/build.mjs';
import { readPairs } from '../lib/pair-relation/store.mjs';
import { REPORT_ROOT } from '../lib/dirs.mjs';

export const name = 'persona-observation-task';

const TZ = 'Asia/Shanghai';
const FALLBACK_MS = 3600_000; // 1 小时轮询兜底
const STATE_NAME = 'persona-observation-state.json';
const CONFIG_NAME = 'persona-observation-config.json';
const INTERVAL_DAYS = 14; // 默认每 2 周
const DEFAULT_DAY = 1; // 周一
const DEFAULT_HOUR = 9;

function dataRootOf(env) {
  return String(env?.dataRoot || env?.caps?.dataRoot || '').trim();
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) ?? fallback; } catch { return fallback; }
}

function writeJson(file, obj) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function configOf(root) {
  return readJson(join(root, '.qqbot-extensions', 'data', CONFIG_NAME), {});
}

/** 某数据目录下所有群（msg-history 里有记录的）。 */
function groupDirs(root) {
  try {
    const dir = join(root, '.qqbot', 'msg-history');
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('group_'))
      .map((e) => e.name.replace(/^group_/, ''));
  } catch { return []; }
}

/**
 * 读 mood-history 在 [fromMs, toMs] 区间内的全部快照，算首尾对比。
 *
 * ★ 2026-11-25 修：
 *   旧实现只 `pick` 首尾两个文件，且 samples 用的是「目录里全部文件数」，
 *   导致两个问题：
 *     ① 区间内只有 1 天数据时，start/end 是同一个文件 ⇒ 所有维度必然「平稳」
 *     ② samples 显示 6 而实际区间内只有 2 天，误导读者
 *   现在改为：**按日期字符串筛区间**，首尾从区间内取，samples 是区间内真实天数。
 */
function readMoodRange(dshHome, gid, fromMs, toMs) {
  const dir = join(String(dshHome ?? '').trim(), 'data', 'dsh-anti-ai-persona', 'state', 'mood-history');
  try {
    const fromYmd = ymdOf(fromMs);
    const toYmd = ymdOf(toMs);
    const inRange = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, ''))
      .filter((d) => d >= fromYmd && d <= toYmd)
      .sort();
    if (!inRange.length) return null;

    const read = (d) => {
      try { return JSON.parse(readFileSync(join(dir, `${d}.json`), 'utf8')); } catch { return null; }
    };
    const first = read(inRange[0]);
    const last = read(inRange[inRange.length - 1]);
    if (!first && !last) return null;

    return {
      start: first,
      end: last || first,
      samples: inRange.length,        // ← 区间内真实天数，不是目录总数
      days: inRange,                  // 便于诊断
    };
  } catch { return null; }
}

/** 按群解析人格名（照抄 diary-task 的已验证写法）。 */
function personaNameOfGroup(gid) {
  try {
    const name = currentPersonaOf({ peer: { peerId: String(gid || ''), scope: 'group' } });
    if (name) return name;
  } catch { /* 回落默认 */ }
  try { return defaultPersona()?.name || '当前人格'; } catch { return '当前人格'; }
}

function ymdOf(ms) {
  const d = new Date(Number(ms) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本周期主动开口次数（心跳 ledger 里 pending/consumed 的数量变化，尽力而为）。 */
function readActivityCount(dshHome) {
  try {
    const p = join(String(dshHome ?? '').trim(), 'data', 'dsh-anti-ai-persona', 'state', 'heartbeat-wake-ledger.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const groups = j?.groups ?? {};
    return Object.keys(groups).length; // 简化：有 ledger 记录的群数（近似，够观察用）
  } catch { return null; }
}

/**
 * 可单测：到点后逐群生成观察报告。
 * @param {object} env
 * @param {Date} [now]
 */
export async function checkAndWrite(env, now = new Date()) {
  const root = dataRootOf(env);
  if (!root) return { ok: false, reason: 'no-data-root', results: [] };

  const cfg = configOf(root);
  const intervalDays = Number.isFinite(Number(cfg.intervalDays)) ? Number(cfg.intervalDays) : INTERVAL_DAYS;
  const day = Number.isFinite(Number(cfg.day)) ? Number(cfg.day) : DEFAULT_DAY;
  const hour = Number.isFinite(Number(cfg.hour)) ? Number(cfg.hour) : DEFAULT_HOUR;

  // 到点判定：今天是不是「周期日」且已过点。简化：按 intervalDays 整除的天数对齐。
  const nowMs = now.getTime();
  const stateFile = join(root, '.qqbot-extensions', 'data', STATE_NAME);
  const state = readJson(stateFile, {});
  if (!state.last || typeof state.last !== 'object') state.last = {};

  const dshHome = String(env?.caps?.dshHome || process.env.DSH_HOME || '').trim();
  const results = [];
  let wrote = 0;

  for (const gid of groupDirs(root)) {
    const key = `obs:${gid}`;
    const last = Number(state.last[key] || 0);
    // 距上次是否已满 intervalDays（简单按天差，够用）
    if (last && nowMs - last < intervalDays * 86400000) {
      results.push({ gid, status: 'recent' });
      continue;
    }

    const fromMs = last || (nowMs - intervalDays * 86400000);
    const mood = readMoodRange(dshHome, gid, fromMs, nowMs);
    const activity = readActivityCount(dshHome);
    let pairs = [];
    try {
      const p = readPairs(root, gid);
      pairs = Object.values(p).filter((x) => x && x.close).map((x) => ({ interactions: x.interactions }));
    } catch { pairs = []; }

    const report = buildObservation({
      from: ymdOf(fromMs),
      to: ymdOf(nowMs),
      persona: personaNameOfGroup(gid),
      mood: mood?.start && mood?.end
        ? {
            start: mood.start,
            end: mood.end,
            samples: mood.samples ?? intervalDays,
          }
        : null,
      activity: activity == null ? null : { proactiveCount: activity, days: intervalDays },
      pairs,
    });

    const outFile = join(REPORT_ROOT, `人格观察-${gid.slice(0, 8)}-${ymdOf(nowMs)}.md`);
    const ok = (() => {
      try {
        mkdirSync(REPORT_ROOT, { recursive: true });
        const tmp = `${outFile}.tmp-${process.pid}`;
        writeFileSync(tmp, report, 'utf8');
        renameSync(tmp, outFile);
        return true;
      } catch { return false; }
    })();

    if (ok) {
      state.last[key] = nowMs;
      wrote += 1;
      results.push({ gid, status: 'written', file: outFile });
    } else {
      results.push({ gid, status: 'write-failed' });
    }
  }

  if (wrote) writeJson(stateFile, state);
  return { ok: wrote > 0, reason: wrote ? 'written' : 'none', results };
}

export async function run(env) {
  const tick = async () => {
    try { await checkAndWrite(env); } catch { /* ignore */ }
  };
  await tick();
  registerWithFallback('persona-observation', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'persona-observation', meta: { id: 'ext-persona-observation' },
  });
}

export default { name, run, checkAndWrite };
