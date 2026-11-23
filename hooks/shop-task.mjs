/**
 * hooks/shop-task — 小店的定时触发（2026-11-17）
 *
 * 每天两次：开店 / 打烊。但不机械 —— 三个防"每日播报"的限制：
 *   ① **概率**：开店 70% / 打烊 60% 才说话（不说也照常开关店）
 *   ② **让位真实对话**：群内 5 分钟内有真人说话 → 推迟 15 分钟
 *   ③ **随机窗口**：在 08:00-09:30 / 21:00-22:30 内随机挑时刻
 *
 * ⚠️ 为什么不在任务中心登记：
 *   任务中心的任务是"每 N 毫秒跑一次"，没法表达"每天某个窗口内随机一次"。
 *   这里用 interval（每 20 分钟检查一次）+ 内部状态判断"今天该开没开"，
 *   既能表达窗口语义，又不依赖新增的任务类型。
 *
 * ⚠️ 失败必须关闭。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, EXT_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { SHOP_ROOT, PERSONA_ROOT, MSG_HISTORY_ROOT } from '../lib/dirs.mjs';

export const name = 'shop-task';

/** 检查间隔：20 分钟（够密，又能覆盖窗口）。 */
const CHECK_EVERY_MS = 20 * 60_000;

function diag(tag, data) {
  try {
    const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'dsh-anti-ai-persona');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'shop-task.log'),
      `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`, 'utf8');
  } catch { /* ignore */ }
}

async function shopMod() {
  return import(pathToFileURL(`${EXT_ROOT}/lib/shop/index.mjs`).href
    + '?task=' + Date.now());
}
async function switchMod() {
  return import(pathToFileURL(`${EXT_ROOT}/lib/io/persona-switch.mjs`).href
    + '?task=' + Date.now());
}
async function llmHostMod() {
  return import(pathToFileURL(
    `${EXT_ROOT}/lib/shop/adapters/llm-host.mjs`,
  ).href + '?task=' + Date.now());
}

async function personaPathMod() {
  return import(pathToFileURL(`${EXT_ROOT}/lib/io/persona-path.mjs`).href
    + '?task=' + Date.now());
}

/** 拿所有有群人格记录的群。 */
async function allGroups() {
  try {
    const S = await switchMod();
    const st = S.loadState();
    return Object.keys(st?.groups || {});
  } catch { return []; }
}

/** 某群当前人格。 */
async function personaOf(gid) {
  try {
    const S = await switchMod();
    const st = S.loadState();
    const g = S.groupState(st, gid);
    return String(g?.persona || '');
  } catch { return ''; }
}

/** 群最近活跃度：N 毫秒内有真人说话吗。 */
async function recentlyActive(gid, withinMs) {
  try {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const root = MSG_HISTORY_ROOT;
    const dir = join(root, `group_${gid}`);
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(-1);
    if (files.length === 0) return false;
    const f = join(dir, files[0]);
    // 文件本身太旧 → 不活跃
    const mt = statSync(f).mtimeMs;
    if (Date.now() - mt > withinMs) return false;
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-30);
    const cutoff = Date.now() - withinMs;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const j = JSON.parse(lines[i]);
        if (j.s === 'self') continue;
        if (Number(j.t) >= cutoff) return true;
      } catch { /* ignore */ }
    }
    return false;
  } catch { return false; }
}

/** 在窗口内吗。 */
function inWindow(now, win) {
  const p = new Date(now);
  // 简单按本地小时判断（配置里 timezone 主要影响存档日期，窗口判断用系统本地时）
  const h = p.getHours();
  const m = p.getMinutes();
  const cur = h * 60 + m;
  const s = win.startHour * 60 + win.startMin;
  const e = win.endHour * 60 + win.endMin;
  return cur >= s && cur <= e;
}

export async function run(env) {
  const ctx = env?.ctx;
  const logger = env?.logger || {};

  let stopped = false;
  let timer;

  async function tick(trigger) {
    if (stopped) return;
    try {
      const { createShop } = await shopMod();
      // ★ LLM 润色（只在定时任务里接 —— 按钮回调里拿不到 kernel.get('llm')，实测 2026-10-13）
      let llm;
      try {
        const L = await llmHostMod();
        llm = L.createHostLlm({ ctx, logger });
      } catch (e) {
        diag('LLM-INIT-FAIL', { err: e instanceof Error ? e.message : String(e) });
        llm = undefined;
      }
      const shop = createShop({
        dataRoot: SHOP_ROOT,
        personaRoot: PERSONA_ROOT,
        cfg: {},
        llm,
        logger,
      });
      const cfg = shop.cfg;
      if (cfg.enabled !== true) return;

      const now = Date.now();
      const groups = await allGroups();
      for (const gid of groups) {
        try {
          const persona = await personaOf(gid);
          const state = shop.snapshot(gid);

          // ── 开店窗口 ──
          if (inWindow(now, cfg.openWindow)) {
            const needOpen = !state || !state.openToday;
            if (needOpen) {
              // 让位：群刚刚在聊 → 跳过这次（下次再试）
              const active = await recentlyActive(gid, cfg.yieldIfActiveWithinMs);
              if (active) {
                diag('OPEN-DEFER', { gid: gid.slice(0, 8), reason: 'chat-active' });
                continue;
              }
              const r = await shop.open(gid, { personaName: persona, nowMs: now });
              if (r.ok) {
                diag('OPEN', { gid: gid.slice(0, 8), day: r.state?.day, spoke: false });
                // 概率说话
                if (r.copy && Math.random() < cfg.openSpeakChance) {
                  try { await env?.sendToGroup?.(gid, r.copy); diag('OPEN-SPEAK', { gid: gid.slice(0, 8) }); }
                  catch { /* ignore */ }
                }
              }
            }
          }

          // ── 打烊窗口 ──
          if (inWindow(now, cfg.closeWindow)) {
            const needClose = state && state.openToday;
            if (needClose) {
              const active = await recentlyActive(gid, cfg.yieldIfActiveWithinMs);
              if (active) {
                diag('CLOSE-DEFER', { gid: gid.slice(0, 8), reason: 'chat-active' });
                continue;
              }
              const r = await shop.close(gid, { nowMs: now });
              if (r.ok) {
                diag('CLOSE', { gid: gid.slice(0, 8), revenue: r.revenue, sold: r.sold });
                if (r.copy && Math.random() < cfg.closeSpeakChance) {
                  try { await env?.sendToGroup?.(gid, r.copy); diag('CLOSE-SPEAK', { gid: gid.slice(0, 8) }); }
                  catch { /* ignore */ }
                }
              }
            }
          }

          // ── 每月归档 ──
          if (state && new Date(now).getDate() === 1) {
            shop.archive(gid, now);
          }
        } catch (e) {
          diag('GROUP-ERR', { gid: gid.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      diag('TICK-ERR', { trigger, err: e instanceof Error ? e.message : String(e) });
    }
  }

  const loop = () => {
    timer = setTimeout(async () => {
      await tick('interval');
      if (!stopped) loop();
    }, CHECK_EVERY_MS);
    timer.unref?.();
  };

  // 启动后 3 分钟先跑一次（给宿主启动留时间）
  const startup = setTimeout(async () => {
    await tick('startup');
    if (!stopped) loop();
  }, 3 * 60_000);
  startup.unref?.();

  try {
    env?.registerDispose?.(() => {
      stopped = true;
      try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
      try { clearTimeout(startup); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  diag('BOOT', { msg: 'shop-task 已启动', every: CHECK_EVERY_MS });
  return 'ok';
}

export default { name, run };