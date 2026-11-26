/**
 * life-stream-task — 生活流 tick（R7 Stage 2，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 每小时跑一次，给每个群记一条「她此刻在做什么」。
 *
 *   ⚠️ 关键：**绝不推送**。只落本地文件，供心跳时引用。
 *      推送会变成刷屏噪音，那不是陪伴，是骚扰。
 *
 *   ⚠️ 零 LLM：每小时 ×24 ×N群 的调用量不可接受，全部模板生成。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { join } from 'node:path';

import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { pickActivity } from '../lib/life-stream/pick.mjs';
import { renderActivity } from '../lib/life-stream/render.mjs';
import { appendLifeLog, recentKinds } from '../lib/life-stream/store.mjs';

const name = 'life-stream-task';

/** 每小时一次。 */
const FALLBACK_MS = 3600_000;

/** 情绪状态文件（插件写，我们只读）。 */
const MOOD_FILE = '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/data/dsh-anti-ai-persona/state/mood-axes.json';

function diag(event, data = {}) {
  try {
    const file = join(EXT_DATA, 'life-stream-diag.log');
    mkdirSync(EXT_DATA, { recursive: true });
    appendLogRotating(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 读当前情绪状态（失败回落中性，不回落 0 —— 0 会让"读失败"伪装成"在睡觉"）。 */
async function readMood() {
  const NEUTRAL = { mood: 0.5, energy: 0.6 };
  try {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(MOOD_FILE, 'utf8');
    const j = JSON.parse(raw);
    return {
      mood: Number.isFinite(Number(j?.mood)) ? Number(j.mood) : NEUTRAL.mood,
      energy: Number.isFinite(Number(j?.energy)) ? Number(j.energy) : NEUTRAL.energy,
    };
  } catch {
    return { ...NEUTRAL };
  }
}

/** 列出所有群（从存档目录推断，避免依赖 msg-history 的 7 天限制）。 */
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

export async function run(env) {
  const tick = async () => {
    try {
      const now = Date.now();
      const mood = await readMood();
      const groups = listGroups();
      if (!groups.length) return;

      let wrote = 0;
      for (const gid of groups) {
        try {
          const recent = recentKinds(gid, 3);
          const hasHistory = recent.length > 0;
          const kind = pickActivity({ mood, hasHistory }, now, recent);
          const detail = renderActivity(kind, mood, now);
          if (!detail) continue;
          // ★ 2026-11-26 再修（R7 修复被回退了）：
                    //   ① 字段名必须是 activity（store 的 normalizeEntry 只认它，用 kind 会被拒写）
                    //   ② 必须带 mood，否则 clamp01(undefined) 让情绪永远是 0（假数据）
                    const ok = appendLifeLog(gid, { at: now, activity: kind, detail, mood });
          if (ok) wrote += 1;
        } catch { /* 单群失败不影响其他 */ }
      }
      if (wrote > 0) diag('tick', { groups: groups.length, wrote, mood });
    } catch (e) {
      diag('failed', { err: e instanceof Error ? e.message : String(e) });
    }
  };

  // 启动即跑一次（重启后补上错过的整点）
  await tick();

  registerWithFallback('life-stream-task', () => tick(), {
    env, fallbackMs: FALLBACK_MS, label: 'life-stream-task', meta: { id: 'ext-life-stream' },
  });
}

export default { name, run };
