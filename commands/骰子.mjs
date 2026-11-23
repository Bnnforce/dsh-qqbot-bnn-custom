/**
 * /骰子 —— 掷骰子（2026-11-09 改：无参数走卡片，带参数走纯文本）
 *
 * 用法：
 *   /骰子            → **发 botplay 卡片**（1d6，带「🎲 再来一次」按钮）
 *   /骰子 d20        → 纯文本回（1 个 20 面骰）
 *   /骰子 2d6        → 纯文本回（2 个 6 面骰）
 *   /骰子 3d10+2     → 纯文本回（3 个 10 面骰，加 2）
 *
 * 为什么带参数时不走卡片（有意分工）：
 *   botplay 事件**拿不到斜杠命令的参数**（事件由 `triggerBotplay(ns, target, eventId)` 触发，
 *   签名里没有 args 通道）。所以卡片版只能固定 1d6。
 *   与其让 `/骰子 2d6` 的参数被默默忽略，不如：
 *     · 不带参数 → 走卡片（好看、能连点「再来一次」）
 *     · 带参数   → 走纯文本（参数真正生效）
 *   两条路都不丢功能。
 *
 * 🔴 安全：表达式用 `parseDiceExpr` 的**手写严格正则**，绝不 eval。
 *
 * 冷却：同人同群 2 秒（卡片路径不经过这里，游戏事件本身靠点击节奏天然限流）。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { rollDice, resolveConfig, DEFAULT_CONFIG } from '../lib/pure/game-core.mjs';
import { runGameCommand, dataRootOf } from '../lib/game-command.mjs';

/** 读配置（失败回落默认，绝不让命令失效）。 */
function loadCfg(root) {
  if (!root) return resolveConfig(DEFAULT_CONFIG);
  const file = join(root, '.qqbot-extensions', 'data', 'game-config.json');
  try {
    return resolveConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch { /* ignore */ }
    return resolveConfig(DEFAULT_CONFIG);
  }
}

/** 载入上游 botplay 模块（统一走 lib/plugin-dist.mjs；见该文件头的技术债说明）。 */
async function loadBotplay() {
  const { importPluginModule } = await import('../lib/io/plugin-dist.mjs');
  return importPluginModule('features/botplay.js');
}

function nsOf(ctx) {
  return String(ctx?.caps?.settingsNs ?? ctx?.settingsNs ?? ctx?.config?.settingsNs ?? 'im-qqbot-2').trim();
}

export default {
  name: ['骰子', 'dice', 'touzi'],
  description: '掷骰子：/骰子 发卡片（可连点）；/骰子 2d6 指定骰子（纯文本）',
  usage: '/骰子 [NdM]',

  async handler(ctx) {
    const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();

    // ── 不带参数 → botplay 卡片（可连点「再来一次」）──
    if (!raw) {
      try {
        const M = await loadBotplay();
        if (M?.triggerBotplay && M?.resolveCommandTarget) {
          const { target, triggererId } = M.resolveCommandTarget(ctx);
          if (target?.targetId && triggererId) {
            const r = await M.triggerBotplay(nsOf(ctx), target, 'dice', triggererId);
            if (r?.ok) return '';   // 卡片已发出，不再额外回文本
          }
        }
      } catch { /* 卡片失败 → 落到下面的纯文本兜底 */ }
      // 卡片发不出去也不能让命令没反应：退回纯文本 1d6
      const cfg = loadCfg(dataRootOf(ctx));
      return rollDice('', cfg);
    }

    // ── 带参数 → 纯文本（参数真正生效）──
    return runGameCommand(ctx, '骰子', (cfg, expr) => rollDice(expr, cfg));
  },
};
