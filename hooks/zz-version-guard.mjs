/**
 * zz-version-guard — 版本/契约不一致只告警；commands/inbound mtime 变化时重新 import 校验。
 *
 * 注意：DSH 扩展链由宿主装载，hook 无法替换已经挂进链里的 handler；
 * 这里做的是“启动期契约检查 + 文件变更后的重新 import 校验/告警”，
 * 真正让新 handler 生效仍要用宿主 tools_reload 或重启。
 *
 * 2026-11-04（阶段 1 收编）：**节律交给中央调度器**。
 *   原来这里自带 `setInterval(60s)`。现在只把 `checkMtimes(env)` 登记给任务中心，
 *   频率由 `{工作区}/任务中心/tasks.json` 的 `ext-version-guard`（everyMs=60000）决定。
 *   启动时仍先跑一次版本检查（行为不变）；引擎缺席时自动降级回自带定时器。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { writeJsonAtomic } from '../lib/pure/atomic.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT, EXT_DATA, EXT_ROOT } from '../lib/pack-paths.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';

export const name = 'version-guard';
const OUT = join(EXT_DATA, 'version-guard.json');
/** 降级用的原节律（仅当任务中心没接管时才生效）。 */
const FALLBACK_MS = 60_000;

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function pkgVersion(paths) {
  for (const p of paths) {
    const j = readJson(p);
    if (j?.version) return j.version;
  }
  return '';
}
function versionAtLeast(actual, minimum) {
  const a = String(actual || '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const b = String(minimum || '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}
function versions() {
  const home = homedir();
  const qqbot = pkgVersion([
    join(home, '.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot/package.json'),
    `${process.env.HOME || '{DSH_HOME}/files/home'}/.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot/package.json`,
  ]);
  const dsh = pkgVersion([
    join(home, '.dsh/profiles/web/node_modules/@deepseek-ai/dsh/package.json'),
    `${process.env.PREFIX || '{DSH_HOME}/files/usr'}/lib/node_modules/@deepseek-ai/dsh/package.json`,
  ]) || String(process.env.DSH_VERSION || '');
  const pack = readJson(join(EXT_ROOT, 'qqbot-pack.json')) || {};
  return {
    qqbot,
    dsh,
    contract: String(pack.minPluginVersion || ''),
    pack: String(pack.version || ''),
  };
}
function write(row) {
  try { mkdirSync(EXT_DATA, { recursive: true }); writeJsonAtomic(OUT, row); } catch { /* ignore */ }
}
function warn(env, msg) {
  try { (env.logger ?? env.log)?.warn?.(`[version-guard] ${msg}`); } catch { /* ignore */ }
}

const mtimes = new Map();
function scanFiles(dir) {
  const out = [];
  try {
    for (const name of requireList(dir)) {
      if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue;
      const abs = join(dir, name);
      try { out.push({ abs, mtime: statSync(abs).mtimeMs }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}
function requireList(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

async function checkMtimes(env) {
  const dirs = [join(EXT_ROOT, 'commands'), join(EXT_ROOT, 'inbound')];
  const changes = [];
  for (const dir of dirs) {
    for (const f of scanFiles(dir)) {
      const prev = mtimes.get(f.abs);
      if (prev !== undefined && prev !== f.mtime) {
        changes.push(f.abs);
        try {
          await import(pathToFileURL(f.abs).href + '?mtime=' + f.mtime);
        } catch (e) {
          warn(env, `重载校验失败，保留旧版本: ${f.abs}: ${e?.message ?? e}`);
        }
      }
      mtimes.set(f.abs, f.mtime);
    }
  }
  if (changes.length) {
    const row = {
      timestamp: new Date().toISOString(),
      changed: changes,
      note: '仅重新 import 校验；真正生效需宿主 tools_reload 或重启',
    };
    write(row);
    warn(env, `commands/inbound 文件变化: ${changes.length} 个`);
  }
  return changes;
}

export async function run(env) {
  const v = versions();
  const expected = v.contract;
  const mismatch = expected && v.qqbot && !versionAtLeast(v.qqbot, expected);
  const row = {
    timestamp: new Date().toISOString(),
    versions: v,
    expectedMinPlugin: expected,
    status: mismatch ? 'warn' : 'ok',
    note: mismatch ? 'QQBot 版本与扩展包 minPluginVersion 不一致，仅告警' : '',
  };
  write(row);
  if (mismatch) warn(env, `QQBot ${v.qqbot} != minPluginVersion ${expected}`);
  for (const dir of [join(EXT_ROOT, 'commands'), join(EXT_ROOT, 'inbound')]) {
    for (const f of scanFiles(dir)) mtimes.set(f.abs, f.mtime);
  }
  // 节律交给中央调度器；引擎若缺席，3 秒后自动降级为自带 60s 定时器
  registerWithFallback('version-guard', () => checkMtimes(env), {
    env, fallbackMs: FALLBACK_MS, label: 'version-guard', meta: { id: 'ext-version-guard' },
  });
  return 'ok';
}
export default { name, run };
