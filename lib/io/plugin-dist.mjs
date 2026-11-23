/**
 * plugin-dist — 插件 dist 模块的**唯一解析入口**（2026-11-15 新增）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 *
 * 有 5 个扩展需要调插件的**内部模块级入口**（`botplay.js` 的 `triggerBotplay` /
 * `resolveCommandTarget`、`session-registry.js` 的 `findManagerByPeer`）。
 * 这些**不是**扩展契约里的公开能力（caps / 全局符号都没有），只能按文件路径 import。
 *
 * 原来每个文件各写一份候选路径表 —— 5 个文件、18 处硬编码绝对路径，改一处漏四处。
 * 更糟的是各处写法还不一致（有的 `existsSync` 预检、有的 `realpathSync`、有的直接遍历）。
 * 现在统一收口到这里：候选顺序、存在性校验、`file://` 转换、失败静默全部一致。
 *
 * ⚠️ **这是已知技术债，不是推荐做法**。官方 `docs/extension-contract.md` 明确写：
 *   「不要 import 插件的 dist/。那些是内部模块，重构时不保证形状；一改就静默坏掉
 *     （import 抛错常被 try 吞了）。」
 *   所以这里的每个调用方都必须 **try/catch + 有降级路径**，且升级大版本后要复核：
 *   导出名是否还在（见下方 EXPORTS 清单）。
 *
 * 已核销的（不需要再走这里）：
 *   · `qq-media.mjs` 原来 import `dist/features/md-media.js` 的 `imageSize()` —— 2026-11-15
 *     已把那段纯字节解析（45 行，无插件状态依赖）本地化，彻底去掉依赖。
 *
 * 剩余 5 处（均为「无公开替代品」）：见 useBlog 下方调用点注释。
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** 插件包在 profile 里的相对位置（node_modules 下） */
const PKG_REL = join('node_modules', '@zaofan', 'dsh-qqbot', 'dist');

/**
 * 组装候选 profile 根目录（按**优先级**排序，去重）。
 *
 * ⚠️ 顺序很关键，踩过（2026-11-15）：Android 上 `/data/data/<pkg>/...` 与
 *   `/data/user/0/<pkg>/...` 是**同一份文件的两个挂载视角**（实测 inode、dev 全相同）。
 *   但 **ESM 按 URL 缓存模块** —— 两个路径 = **两个模块实例**，各自的模块级状态（如
 *   session-registry 的 `managers` Map、botplay 的 `triggerImpls`）**互不相通**。
 *   症状：扩展从这里 import 拿到的 registry 是空的那一份，`findManagerByPeer()` 永远 null。
 *
 *   所以候选顺序必须与**插件自己加载时用的那条路径**一致 —— 也就是 HOME/.dsh 派生
 *   （插件是被 DSH 引擎用 HOME 视角加载的）。DSH_HOME 视角只作后置兜底。
 */
function profileRoots() {
  const out = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  // ① HOME/.dsh —— 与引擎加载插件时同一条路径（**必须排第一**，否则模块实例对不上）
  push(process.env.HOME && join(process.env.HOME, '.dsh', 'profiles', 'web'));
  // ② homedir()（HOME 未设时的等价兜底）
  try { push(join(homedir(), '.dsh', 'profiles', 'web')); } catch { /* ignore */ }
  // ③ DSH_HOME 派生（另一挂载视角，仅在前两条都找不到时用）
  push(process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles', 'web'));
  // ④ 本机绝对兜底（保序：HOME 视角在前）
  push(`${process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home'}/.dsh/profiles/web`);
  push(`${process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home'}/.dsh/profiles/web`);
  return out;
}

/** 某模块的候选绝对路径（存在性已校验；不存在的不返回） */
export function moduleCandidates(distRelPath) {
  const rel = String(distRelPath ?? '');
  if (!rel) return [];
  const seen = new Set();
  const out = [];
  for (const root of profileRoots()) {
    let p;
    try { p = join(root, PKG_REL, rel); } catch { continue; }
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      // realpathSync 顺带校验存在性：断链/不存在会抛，直接跳过
      out.push(realpathSync(p));
    } catch { /* 不存在 */ }
  }
  return out;
}

/**
 * 按需 import 一个插件 dist 模块；全都失败返回 null（**绝不抛**）。
 * 调用方必须自己判空并走降级路径。
 *
 * @param {string} distRelPath 相对 `dist/` 的路径，如 `features/botplay.js`
 * @returns {Promise<object|null>}
 */
export async function importPluginModule(distRelPath) {
  for (const file of moduleCandidates(distRelPath)) {
    try {
      return await import(pathToFileURL(file).href);
    } catch { /* 下一个候选 */ }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// 已知调用点（改任何一处都要同步看这里 + 升级后复核导出名）
//
//   features/botplay.js
//     · triggerBotplay(ns, target, eventId, triggererId)   ← 命令侧发 botplay 卡片
//     · resolveCommandTarget(ctx) → {target, triggererId}  ← 从命令 ctx 取回复目标
//     调用点：commands/骰子.mjs、lib/card-nav.mjs（卡片功能按钮转发）、
//             .qqbot-extensions/commands/日历.mjs、.qqbot-extensions/commands/旧指令事件桥.mjs
//
//   features/session-registry.js
//     · findManagerByPeer(scope, peerId) / managersOf()    ← 多实例时定位实例 manager
//     调用点：lib/card-nav.mjs、.qqbot-extensions/botplay/persona-switch.mjs
//     （⚠️ 这两个文件都有 ctx.kernel.get('qqChannel').manager 主路径，
//        走 registry 只是 fallback，所以这里失败不影响主功能）
// ───────────────────────────────────────────────────────────────────────────

export default { moduleCandidates, importPluginModule };
