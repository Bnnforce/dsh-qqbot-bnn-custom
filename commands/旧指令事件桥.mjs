/**
 * 旧指令 → botplay 事件桥
 *
 * 保留老习惯的斜杠入口，但卡片/逻辑统一走 botplay 事件：
 *   /来张图       → random-image
 *   /随心配 /取消配对 → pairing（发事件卡，点按钮完成配对/取消）
 *
 * 需要当前插件实例已加载 botplay 控制器；找不到就返回明确错误。
 *
 * ★ 2026-11-09：已移除 `/有谁开播了`（主人要求）。
 *   同时删掉了 `botplay/bnn-live.mjs` 事件与 `lib/bnn-live.mjs` 查询逻辑；
 *   备份在 `维护/归档/bnn-live-removal-20261109-1830/`。
 */

const MAP = new Map([
  ['来张图', 'random-image'],
  ['随心配', 'pairing'],
  ['取消配对', 'pairing'],
  ['人格切换', 'persona-switch'],
  // ★ 2026-11-09：猜拳改成 botplay 卡片（盲出）。
  //   原来独立的 commands/猜拳.mjs 直接回文本、而且**暴露她出的手势**，已删除。
  ['猜拳', 'rps'],
  // ★ 2026-11-09 第二轮：抽签也改卡片（先说吉凶 + 再来一签）。
  ['抽签', 'fortune'],
]);

async function loadBotplay() {
  try {
    const { importPluginModule } = await import('../lib/io/plugin-dist.mjs');
    return await importPluginModule('features/botplay.js');
  } catch { return null; }
}

function nsOf(ctx) {
  return String(
    ctx?.caps?.settingsNs
    ?? ctx?.settingsNs
    ?? ctx?.config?.settingsNs
    ?? 'im-qqbot-2',
  ).trim();
}

export default {
  name: [...MAP.keys()],
  usage: '/随心配 /来张图 /猜拳 /抽签 /人格切换',
  description: '旧斜杠指令入口：转成 botplay 事件卡片（/骰子 见 commands/骰子.mjs，支持参数）',

  async handler(ctx) {
    const name = String(ctx?.command?.name ?? '').trim();
    const eventId = MAP.get(name);
    if (!eventId) return `未知事件指令：${name}`;

    const M = await loadBotplay();
    if (!M?.triggerBotplay || !M?.resolveCommandTarget) return '事件系统未就绪，请重启 DSH 后再试。';
    const { target, triggererId } = M.resolveCommandTarget(ctx);
    if (!target?.targetId || !triggererId) return '无法定位当前会话，请稍后再试。';

    const r = await M.triggerBotplay(nsOf(ctx), target, eventId, triggererId);
    if (r?.ok) return ''; // 卡片已发出，不再额外回文本
    return r?.msg || `事件「${eventId}」发卡失败。`;
  },
};
