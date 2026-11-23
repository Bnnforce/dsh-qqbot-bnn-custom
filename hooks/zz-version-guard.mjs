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
import { checkPluginCompat, versionAtLeast } from '../lib/pure/version.mjs';
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
// versionAtLeast 已移到 lib/pure/version.mjs（与 compat 检查共用同一实现）
function versions() {
  const home = homedir();
  const qqbot = pkgVersion([
    join(home, '.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot/package.json'),
    `${process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home'}/.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot/package.json`,
  ]);
  const dsh = pkgVersion([
    join(home, '.dsh/profiles/web/node_modules/@deepseek-ai/dsh/package.json'),
    `${process.env.PREFIX || '/data/data/com.dsharnessmobile.shell/files/usr'}/lib/node_modules/@deepseek-ai/dsh/package.json`,
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
  const pack = readJson(join(EXT_ROOT, 'qqbot-pack.json')) || {};
  /**
   * 兼容性判定（2026-11-23 新增「上限」检查）。
   *
   * 为什么必须有：上游只声明 minPluginVersion（下限），**没有上限机制**，
   * 而真实风险是向上不兼容 —— 1.13.21+ 改了 4 个我们打过补丁的文件，
   * 还把 outboundLastCtxFallback 默认改成拒发（影响 outbound/60-split-bubbles）。
   *
   * 策略：**只告警不阻断**。阻断会让用户升级上游后连机器人都起不来，比降级更糟。
   */
  const compat = checkPluginCompat(v.qqbot, {
    min: String(pack.minPluginVersion || ''),
    max: String(pack.maxPluginVersion || ''),
    tested: String(pack.testedWithPlugin || ''),
  });

  // 旧判据（仅下限）保留，防止有人只写了 minPluginVersion
  const belowMin = v.contract && v.qqbot && !versionAtLeast(v.qqbot, v.contract);

  const status = compat.level === 'error' || belowMin ? 'warn'
    : compat.level === 'warn' ? 'warn'
      : 'ok';

  const row = {
    timestamp: new Date().toISOString(),
    versions: v,
    expectedMinPlugin: v.contract,
    testedWithPlugin: String(pack.testedWithPlugin || ''),
    maxPluginVersion: String(pack.maxPluginVersion || ''),
    compat: { status: compat.status, level: compat.level, message: compat.message },
    status,
    note: compat.status === 'ok'
      ? ''
      : (compat.message || (belowMin ? 'QQBot 版本低于 minPluginVersion，仅告警' : '')),
  };
  write(row);

  if (compat.status !== 'ok') {
    warn(env, `[兼容] ${compat.message}`);
    if (compat.status === 'too-new') {
      warn(env, '[兼容] 升级上游后务必：① 重打 4 个 dist 补丁 ② 检查 outboundLastCtxFallback '
        + '③ 跑 node test/... 与 preflight ④ 通过后再把 qqbot-pack.json 的 maxPluginVersion 放宽');
    }
  } else if (v.qqbot) {
    try { (env.logger ?? env.log)?.info?.(`[version-guard] 插件 ${v.qqbot} 与验证版本一致`); } catch { /* ignore */ }
  }
  if (belowMin && compat.status === 'ok') {
    warn(env, `QQBot ${v.qqbot} < minPluginVersion ${v.contract}`);
  }

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
