/**
 * chronicle-task — 群共同经历（R7 Stage 1，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 每天跑一次，把「够格成为共同记忆」的事件提取出来。
 *
 *   够格判定是纯算法（lib/chronicle/extract.mjs），零 LLM：
 *     参与 ≥3 人 +40 / 持续 ≥30 分钟 +30 / 情绪高点 +30，总分 ≥60。
 *
 *   LLM 只在「写编年史叙事」时用，且**每群每周最多 1 次**（节流在本 hook 负责）。
 *   ⚠️ LLM 返回 null 时**绝不调用 writeChronicle** —— 会让旧版被清空。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { extractEventsDetailed } from '../lib/chronicle/extract.mjs';
import { appendEvents, readEvents, writeChronicle, readChronicle } from '../lib/chronicle/store.mjs';
import { buildChroniclePrompt, buildChronicleSystem, sanitizeChronicleText } from '../lib/chronicle/narrative.mjs';
import { writeJsonAtomic, readJsonSafe } from '../lib/pure/atomic.mjs';

const name = 'chronicle-task';

/** 每天一次（低峰）。 */
const FALLBACK_MS = 24 * 3600_000;

/** 编年史重写节流：每群每周最多 1 次。 */
const REWRITE_INTERVAL_MS = 7 * 24 * 3600_000;

/** 节流状态文件。 */
const STATE_FILE = join(EXT_DATA, 'chronicle-state.json');

/** 至少累积多少条事件才值得重写叙事。 */
const MIN_EVENTS_TO_REWRITE = 3;

function diag(event, data = {}) {
  try {
    const file = join(EXT_DATA, 'chronicle-diag.log');
    mkdirSync(EXT_DATA, { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 读某群某天的消息（优先长期存档，回落 msg-history）。 */
function readDayMessages(gid, dateStr) {
  const candidates = [
    join(EXT_DATA, 'msg-archive', `group_${gid}`, `${dateStr}.jsonl`),
    join(EXT_DATA, '..', '..', '.qqbot', 'msg-history', `group_${gid}`, `${dateStr}.jsonl`),
  ];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      const raw = readFileSync(f, 'utf8');
      const out = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
      if (out.length) return out;
    } catch { /* 试下一个 */ }
  }
  return [];
}


function ymdOf(ms) {
  const d = new Date(Number(ms) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function run(env) {
  const tick = async () => {
    try {
      const now = Date.now();
      const dateStr = ymdOf(now);

      // 动态导入 readdirSync（避免顶层 require 在 ESM 里不可用）
      const { readdirSync } = await import('node:fs');
      let groups = [];
      try {
        groups = readdirSync(join(EXT_DATA, 'msg-archive'))
          .filter((d) => d.startsWith('group_'))
          .map((d) => d.replace(/^group_/, ''));
      } catch { /* 无存档 */ }
      if (!groups.length) { diag('skip', { reason: 'no-archive' }); return; }

      const state = readJsonSafe(STATE_FILE, { rewrite: {} }) || { rewrite: {} };
      if (!state.rewrite) state.rewrite = {};

      let extracted = 0;
      let qualified = 0;
      let rewritten = 0;

      for (const gid of groups) {
        try {
          const messages = readDayMessages(gid, dateStr);
          if (!messages.length) continue;

          // ① 纯算法提取（零 LLM）
          const { events, stats } = extractEventsDetailed(messages, { date: dateStr });
          extracted += events.length;
          const ok = events.filter((e) => e.qualified === true);
          qualified += ok.length;

          if (ok.length) appendEvents(gid, ok);
          if (stats?.warnings?.length) diag('extract-warn', { gid: gid.slice(0, 8), warnings: stats.warnings.slice(0, 3) });

          // ② 每周最多重写一次编年史
          const lastAt = Number(state.rewrite[gid]) || 0;
          if (now - lastAt < REWRITE_INTERVAL_MS) continue;

          const all = readEvents(gid);
          if (all.length < MIN_EVENTS_TO_REWRITE) continue;

          const oldText = readChronicle(gid);
          const narrative = await generateNarrative(env, gid, all);
          // ★ 关键：null 时绝不 writeChronicle（否则旧版被清空）
          if (narrative === null || !String(narrative).trim()) {
            diag('narrative-skip', { gid: gid.slice(0, 8), reason: 'empty-or-failed', keepOld: Boolean(oldText) });
            continue;
          }

          if (writeChronicle(gid, narrative)) {
            state.rewrite[gid] = now;
            rewritten += 1;
          }
        } catch (e) {
          diag('group-failed', { gid: gid.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
        }
      }

      if (rewritten > 0) writeJsonAtomic(STATE_FILE, state);
      if (extracted > 0) diag('tick', { date: dateStr, groups: groups.length, extracted, qualified, rewritten });
    } catch (e) {
      diag('failed', { err: e instanceof Error ? e.message : String(e) });
    }
  };

  await tick();

  registerWithFallback('chronicle-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'chronicle-task', meta: { id: 'ext-chronicle' },
  });
}

/**
 * 生成编年史叙事。
 * ⚠️ 调用方必须处理 null —— 返回 null 表示失败，**不能因此清空旧版**。
 */
async function generateNarrative(env, gid, events) {
  try {
    // 复用项目的 wakeTo 思路：让宿主生成，不自己调 LLM（扩展 hook 够不到 llm 服务）
    const wakeTo = env?.wakeTo;
    if (typeof wakeTo !== 'function') {
      diag('narrative-no-wake', { gid: gid.slice(0, 8) });
      return null;
    }
    const prompt = buildChroniclePrompt(gid, events);
    const sent = await wakeTo('group', gid, prompt);
    if (sent === false) return null;
    // wake 成功：正文由宿主生成，本地不落（下次读到的是旧版，等人工或后续同步）
    diag('narrative-woken', { gid: gid.slice(0, 8) });
    return null;  // 返回 null 让调用方保留旧版
  } catch (e) {
    diag('narrative-throw', { gid: gid.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export default { name, run };
