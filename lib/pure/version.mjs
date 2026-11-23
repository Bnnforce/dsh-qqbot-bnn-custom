/**
 * version — 语义化版本比较（纯函数、零 IO、零依赖）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个（2026-11-23）
 *
 *   上游 @zaofan/dsh-qqbot 的扩展包清单**只有 `minPluginVersion`（下限）**，
 *   没有任何「最高版本」机制，而且它只在设置面板里标红，**加载器根本不做校验**。
 *
 *   而真实风险是**向上不兼容**，不是向下：
 *     · 1.13.21~1.13.23 把本包 4 个 dist 补丁的目标文件全改了 ⇒ 升级后补丁冲突
 *     · 同一批版本把 `outboundLastCtxFallback` 默认改成 false（拒发）
 *       ⇒ 本包 outbound/60-split-bubbles 里不传 target 的 `ctx.send()` 会全部失败
 *       ⇒ 多段回复只有第一段能发出去
 *
 *   所以我们自己定义两条声明（写在 qqbot-pack.json）：
 *     · `testedWithPlugin`  —— 我们构建/验证过的那个版本（单一真源）
 *     · `maxPluginVersion`  —— 允许的上限（人工验证新版后手工放宽）
 *   再由 version-guard / doctor 去校验，超范围**只告警不阻断**
 *   （阻断会让用户升级上游后连机器人都起不来，比降级更糟）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 把版本串拆成数字数组。
 * 支持 `1.13.20`、`1.13.20-rc.3`、`v1.13.20`、`1.13.20+build`。
 *
 * @param {string} v
 * @returns {number[]}
 */
export function parseVersion(v) {
  const s = String(v ?? '').trim().replace(/^v/i, '');
  if (!s) return [];
  // 只取主版本段（到 - 或 + 之前），再按点切
  const core = s.split(/[+-]/)[0];
  return core.split('.').map((x) => Number.parseInt(x, 10) || 0);
}

/**
 * 比较两个版本。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} a<b 返回 -1，相等 0，a>b 返回 1
 */
export function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * `actual >= minimum`（保留旧调用方式，语义与 version-guard 原来那个一致）。
 *
 * @param {string} actual
 * @param {string} minimum
 * @returns {boolean}
 */
export function versionAtLeast(actual, minimum) {
  if (!actual || !minimum) return true;
  return compareVersion(actual, minimum) >= 0;
}

/**
 * 判断插件版本是否在本包声明的兼容范围内。
 *
 * 判定顺序（越靠前越严重）：
 *   ① 没装 / 读不到版本        → status 'unknown'
 *   ② 低于 minPluginVersion    → status 'too-old'
 *   ③ 高于 maxPluginVersion    → status 'too-new'   ← 本轮真正关心的
 *   ④ 在范围内但 ≠ testedWith  → status 'untested'  （能用但没验证过）
 *   ⑤ 等于 testedWith          → status 'ok'
 *
 * @param {string} actual 实际安装的插件版本
 * @param {{min?:string, max?:string, tested?:string}} range 声明范围
 * @returns {{status:string, ok:boolean, level:'ok'|'warn'|'error', message:string, actual:string}}
 */
export function checkPluginCompat(actual, range = {}) {
  const a = String(actual ?? '').trim();
  const min = String(range.min ?? '').trim();
  const max = String(range.max ?? '').trim();
  const tested = String(range.tested ?? '').trim();

  if (!a) {
    return {
      status: 'unknown', ok: false, level: 'warn', actual: '',
      message: '读不到已安装的 @zaofan/dsh-qqbot 版本（插件可能没装，或不在预期路径）',
    };
  }

  if (min && compareVersion(a, min) < 0) {
    return {
      status: 'too-old', ok: false, level: 'error', actual: a,
      message: `插件 ${a} 低于本包要求的最低版本 ${min}，扩展点契约可能不存在（会撞 undefined）`,
    };
  }

  if (max && compareVersion(a, max) > 0) {
    return {
      status: 'too-new', ok: false, level: 'warn', actual: a,
      message: `插件 ${a} 高于本包验证过的上限 ${max}。`
        + `上游可能改了扩展点契约、或改了某个默认值（例如 outboundLastCtxFallback 默认改拒发）。`
        + '请先看上游 CHANGELOG，跑一遍本包回归再放宽 maxPluginVersion',
    };
  }

  if (tested && compareVersion(a, tested) !== 0) {
    return {
      status: 'untested', ok: true, level: 'warn', actual: a,
      message: `插件 ${a} 在本包声明的范围内，但不等于验证过的 ${tested}。可用，行为未实测`,
    };
  }

  return {
    status: 'ok', ok: true, level: 'ok', actual: a,
    message: `插件 ${a} 与本包验证版本一致`,
  };
}

export default { parseVersion, compareVersion, versionAtLeast, checkPluginCompat };
