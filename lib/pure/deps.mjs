/**
 * deps.mjs — 可移植的第三方依赖解析
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 问题（2026-11-20 开源可移植性）
 *
 * 扩展包要用 `silk-wasm`（把 PCM 编成 QQ 语音的 SILK 格式）。
 * 以前两个模块各自写死了查找路径：
 *
 *   lib/voice/to-silk.mjs  → `${HOME}/.dsh/profiles/web/node_modules/silk-wasm/...`
 *   lib/song/to-silk.mjs   → `${WORKSPACE_ROOT}/Bot/人格/node_modules/silk-wasm/...`
 *
 * 两个都不对：
 *   · 前者假设用户的 DSH 装在 `~/.dsh/profiles/web`（恰恰是别人的布局可能不同）
 *   · 后者假设数据目录里塞了 node_modules（我们自己某次临时装过，纯属巧合）
 *
 * 结果：别人装上这个包，语音/点歌**静默不可用**，日志里还看不出原因。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 现在的解析顺序（先近后远，全部失败才报错）
 *
 *   ① 环境变量显式指定（BNN_SILK_WASM / BNN_NODE_MODULES）
 *   ② 包内 node_modules（`pnpm add silk-wasm` 装到扩展包里）
 *   ③ 从包位置向上找 node_modules（标准 Node 解析）
 *   ④ DSH profile 的 node_modules（本机常见布局，兜底）
 *
 * 找不到时返回 `{ ok:false, reason, tried:[...] }`，调用方把 tried 打进
 * 错误信息 —— 出问题能一眼看出该往哪装。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** lib/pure → 上两级 = 扩展包根 */
export const PACK_ROOT = resolve(HERE, '..', '..');

/** 常见的 DSH profile node_modules（仅作兜底，不假设一定存在）。 */
function profileNodeModules() {
  const out = [];
  const home = String(process.env.HOME || '').trim();
  if (home) {
    out.push(join(home, '.dsh', 'profiles', 'web', 'node_modules'));
    out.push(join(home, '.dsh', 'node_modules'));
  }
  const dshHome = String(process.env.DSH_HOME || '').trim();
  if (dshHome) {
    out.push(join(dshHome, 'profiles', 'web', 'node_modules'));
    out.push(join(dshHome, 'node_modules'));
  }
  return out;
}

/**
 * 找出某个 npm 包的可导入文件路径。
 *
 * @param {string} pkgName 包名，如 'silk-wasm'
 * @param {{ envVar?: string, entry?: string }} [opts]
 *   envVar: 允许用环境变量直接指定入口文件；entry: 包内相对入口（默认读 package.json 的 main/module）
 * @returns {{ ok:true, path:string, from:string } | { ok:false, reason:string, tried:string[] }}
 */
export function resolvePackageFile(pkgName, opts = {}) {
  const tried = [];

  // ① 环境变量直接给入口文件
  const envVar = opts.envVar;
  if (envVar) {
    const v = String(process.env[envVar] ?? '').trim();
    if (v) {
      tried.push(`${envVar}=${v}`);
      if (existsSync(v)) return { ok: true, path: v, from: envVar };
    }
  }

  // 环境变量给 node_modules 根
  const nmOverride = String(process.env.BNN_NODE_MODULES ?? '').trim();

  // ②③ 交给 Node 的标准解析（从扩展包位置往外找）
  const roots = [];
  if (nmOverride) {
    roots.push({ dir: nmOverride, from: 'BNN_NODE_MODULES' });
  }
  roots.push({ dir: join(PACK_ROOT, 'node_modules'), from: 'pack' });
  for (const nm of profileNodeModules()) roots.push({ dir: nm, from: 'profile' });

  for (const r of roots) {
    const pkgDir = join(r.dir, pkgName);
    tried.push(pkgDir);
    if (!existsSync(pkgDir)) continue;
    // 让 Node 自己解析 package.json 的 exports/main
    try {
      const req = createRequire(join(PACK_ROOT, 'package.json'));
      const resolved = req.resolve(pkgName);
      return { ok: true, path: resolved, from: r.from };
    } catch {
      /* 继续下一个候选 */
    }
    // 兜底：常见入口
    for (const rel of opts.entry ? [opts.entry] : ['lib/index.mjs', 'lib/index.js', 'lib/index.cjs', 'dist/index.js', 'index.js']) {
      const p = join(pkgDir, rel);
      tried.push(p);
      if (existsSync(p)) return { ok: true, path: p, from: r.from };
    }
  }

  // 最后再试一次「从包位置做标准 CJS 解析」
  try {
    const req = createRequire(join(PACK_ROOT, 'package.json'));
    const resolved = req.resolve(pkgName);
    return { ok: true, path: resolved, from: 'node' };
  } catch {
    /* 落空 */
  }

  return {
    ok: false,
    reason: `找不到依赖 "${pkgName}"。请在扩展包目录执行 \`pnpm add ${pkgName}\`，` +
      `或用环境变量 ${envVar || 'BNN_NODE_MODULES'} 指定。`,
    tried,
  };
}

/**
 * 动态 import 一个 npm 包（ESM/CJS 都能吃）。
 *
 * @param {string} pkgName
 * @param {{ envVar?: string, cacheBust?: boolean }} [opts]
 * @returns {Promise<{ ok:true, mod:any, path:string, from:string } | { ok:false, reason:string, tried:string[] }>}
 */
export async function loadPackage(pkgName, opts = {}) {
  const found = resolvePackageFile(pkgName, opts);
  if (!found.ok) return found;
  try {
    const href = pathToFileURL(found.path).href + (opts.cacheBust ? `?t=${Date.now()}` : '');
    const mod = await import(href);
    return { ok: true, mod: mod?.default ?? mod, path: found.path, from: found.from };
  } catch (e) {
    return { ok: false, reason: `依赖 ${pkgName} 已找到但导入失败：${e?.message || e}`, tried: [found.path] };
  }
}

/** 包是否可用（只判断能不能解析到，不 import）。 */
export function hasPackage(pkgName, opts = {}) {
  return resolvePackageFile(pkgName, opts).ok;
}

export default { PACK_ROOT, resolvePackageFile, loadPackage, hasPackage };
