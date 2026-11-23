/**
 * /点歌 —— 免费（2026-11-19 R5.2 本地曲库版）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人要求：
 *   ① 去掉积分（免费功能）
 *   ② /点歌 后展示第一张卡片（功能名 + 介绍 + 两个按钮）
 *
 * ── 实现方式 ───────────────────────────────────────────────────────────────
 *   QQ 卡片按钮的**回调只能**由 botplay 事件处理，命令自己发的卡片点了没人认。
 *   所以本命令只做一件事：**触发 botplay 事件 `song`**。
 *
 *   这套桥接与 `commands/旧指令事件桥.mjs` 同一机制（官方 triggerBotplay）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 插件 dist 模块加载器（官方提供的安全入口）。 */
async function loadBotplay() {
  try {
    const { importPluginModule } = await import('../lib/io/plugin-dist.mjs');
    return await importPluginModule('features/botplay.js');
  } catch {
    return null;
  }
}

/** 取当前插件实例 ns。 */
function nsOf(ctx) {
  return String(
    ctx?.caps?.settingsNs
    ?? ctx?.settingsNs
    ?? ctx?.config?.settingsNs
    ?? 'im-qqbot-2',
  ).trim();
}

export default {
  name: ['点歌', 'song', 'dianqe'],
  description: '点歌（免费）',
  usage: '/点歌',

  async handler(ctx) {
    const M = await loadBotplay();
    if (!M?.triggerBotplay || !M?.resolveCommandTarget) {
      return '事件系统未就绪，请重启 DSH 后再试。';
    }

    const { target, triggererId } = M.resolveCommandTarget(ctx);
    if (!target?.targetId || !triggererId) {
      return '无法定位当前会话，请稍后再试。';
    }

    const r = await M.triggerBotplay(nsOf(ctx), target, 'song', triggererId);
    if (r?.ok) return '';   // 卡片已发出，不再额外回文本
    return r?.msg || '发卡失败（可能需要开启卡片权限）。';
  },
};
