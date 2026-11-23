/**
 * persona-from-file — 规则目录 + 角色卡目录 → groupPrompt。
 *
 * 事实来源：
 *   {workspace}/人格/规则/*.md     按文件名排序全部读取
 *   {workspace}/人格/角色卡/*.md   默认人格文件
 *   {workspace}/人格/persona-config.json
 *
 * 任一层缺失或安全标记缺失则拒绝同步，保留上一份。
 *
 * 2026-11-04（阶段 1 收编）：**节律交给中央调度器**。
 *   · 原来每 15 秒轮询一次；按主人决策 **降到 30 秒**，并且这 30 秒由
 *     `{工作区}/任务中心/tasks.json` 的 `ext-persona-from-file`（everyMs=30000）驱动，
 *     本文件不再自带 setInterval。
 *   · 启动时仍立即 sync 一次（行为不变）。
 *   · 引擎缺席 → 自动降级回自带 30 秒定时器，人格同步不能丢。
 *   · `sync` 内部本来就有「文本没变就直接 return」的短路，所以 30 秒一次也不会重复调 HTTP。
 */
import { composePrompt, readConfig } from '../lib/io/persona-store.mjs';
import { settingsUpdateUrl } from '../lib/dsh-api.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 找到本账号的设置文件（{DSH_HOME}/qqbot-settings/<profile>/<ns>.json）。
 *
 * 为什么需要它（2026-11-06 修）：DSH 给**所有** `/api/*` 加了鉴权，
 *   hook 进程内 fetch 没有凭据 → `/api/qqbot-settings/update` 恒 401。
 *   于是本 hook 的同步**其实已经失败很久**（规则文件改了 groupPrompt 不更新）。
 *   兜底：HTTP 走不通就直接写设置文件。注意写盘后**仍需重启 DSH** 才进配置快照。
 */
function settingsFilePath(ns) {
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qqbot-settings');
  const prefer = join(root, 'web', `${ns}.json`);
  if (existsSync(prefer)) return prefer;
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(root, d.name, `${ns}.json`);
      if (existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return prefer;
}

export const name = 'persona-from-file';

const UPDATE_API = settingsUpdateUrl();
/** 降级用的节律（与 tasks.json 里的 everyMs 保持一致）。 */
const FALLBACK_MS = 30000;

export async function run(env) {
  const logger = env?.logger;
  const cfg = env?.config ?? {};
  const ns = String(cfg.settingsNs || 'im-qqbot-2');
  let lastSent = String(cfg.groupPrompt ?? '').trim();
  let lastError = '';

  function warnOnce(msg) {
    if (msg === lastError) return;
    lastError = msg;
    logger?.warn?.(msg);
  }

  /**
   * 同步一轮。返回**三态**（2026-11-04 修：原来用 boolean，调度器把"没变化"记成失败）：
   *   'ok'   = 真的推送了新的 groupPrompt
   *   'skip' = 内容没变 / 校验不通过（**正常情况**，绝大多数轮询都走这条）
   *   'fail' = HTTP 失败或异常（**真正的错误**）
   */
  async function sync(reason, force = false) {
    try {
      const built = composePrompt(undefined, readConfig());
      if (!built.ok) { warnOnce(`[persona-file] 拒绝同步：${built.reason}`); return 'skip'; }
      const text = built.text;
      const current = String(cfg.groupPrompt ?? '').trim();
      if (!force && text === current) { lastSent = text; lastError = ''; return 'skip'; }
      if (!force && text === lastSent) return 'skip';
      // ── ① 首选 HTTP（能热生效：写进插件设置、事件通知插件重读）──
      try {
        const res = await fetch(UPDATE_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ns, patch: { groupPrompt: text } }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          lastSent = text;
          lastError = '';
          logger?.info?.(`[persona-file] 已热同步（${reason}, 人格=${built.personaName}, 规则=${built.rulesCount}）：${text.length} 字`);
          return 'ok';
        }
        logger?.warn?.(`[persona-file] HTTP ${res.status}，回落直接写设置文件`);
      } catch (e) {
        logger?.warn?.(`[persona-file] HTTP 异常 ${e instanceof Error ? e.message : String(e)}，回落直接写设置文件`);
      }

      // ── ② 兜底：直接写设置文件 ──
      //   2026-11-06 起 DSH 给所有 /api/* 加了鉴权，hook 没凭据 ⇒ ①恒 401，这里是常态。
      //   写盘后**仍需重启 DSH** 才会进插件的配置快照（插件启动时读一次 config）。
      try {
        const file = settingsFilePath(ns);
        const j = JSON.parse(readFileSync(file, 'utf8'));
        if (String(j.groupPrompt ?? '') !== text) {
          j.groupPrompt = text;
          const tmp = `${file}.tmp-${Date.now()}`;
          writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
          renameSync(tmp, file);
        }
        lastSent = text;
        lastError = '';
        logger?.info?.(`[persona-file] 已写入设置文件（需重启 DSH 生效；${reason}, 人格=${built.personaName}, 规则=${built.rulesCount}）：${text.length} 字`);
        return 'ok';
      } catch (e2) {
        logger?.warn?.(`[persona-file] 写设置文件失败: ${e2 instanceof Error ? e2.message : String(e2)}`);
        return 'fail';
      }
    } catch (e) {
      logger?.warn?.(`[persona-file] 同步异常: ${e instanceof Error ? e.message : String(e)}`);
      return 'fail';
    }
  }

  await sync('启动');
  // 节律交给中央调度器；引擎若缺席，3 秒后自动降级为自带 30s 定时器
  registerWithFallback('persona-from-file', () => sync('轮询'), {
    env, fallbackMs: FALLBACK_MS, label: 'persona-from-file', meta: { id: 'ext-persona-from-file' },
  });
  return 'ok(规则目录+角色卡目录)';
}

export function dispose() { /* interval cleaned via registerDispose */ }
export default { name: 'persona-from-file', run, dispose };
