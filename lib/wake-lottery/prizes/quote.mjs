/**
 * prizes/quote — 一句话（R5.6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是整个抽奖的**最后一道保底**。
 *
 *   设计铁律：**它永远不能失败**。
 *   所以它有内置的硬编码兜底句 —— 连金句文件都读不到时也能回一句话。
 *
 * 来源优先级：
 *   ① {WORKSPACE}/人格/每日金句.txt 随机一句
 *   ② 内置兜底句（3 条，硬编码）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../../pack-paths.mjs';

/** 金句文件路径（可用环境变量重定向，便于测试/移植）。 */
function quoteFile() {
  const override = String(process.env.BNN_QUOTE_FILE ?? '').trim();
  return override || join(WORKSPACE_ROOT, 'Bot', '人格', '每日金句.txt');
}

/**
 * 内置兜底句 —— 必须与人格无关、任何场景都说得通。
 *
 * ⚠️ 开源红线：这里**不能出现人格专属词**（如「爱莉希雅」「粉色妖精」）。
 */
export const FALLBACK_LINES = Object.freeze([
  '慢一点也没关系，今天也够好了。',
  '想到一件小事，忽然觉得挺开心的。',
  '就这样安静一会儿，也挺好。',
]);

/**
 * 是否可用：恒 true（有内置兜底，永远能兑现）。
 * @returns {boolean}
 */
export function available() {
  return true;
}

/**
 * 读金句库（去注释、去空行）。读不到返回空数组。
 * @returns {string[]}
 */
export function readQuotes() {
  try {
    const file = quoteFile();
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
  } catch {
    return [];
  }
}

/**
 * 抽一句话。
 *
 * @param {{random?:()=>number}} [ctx]
 * @returns {{ok:true, payload:{kind:'text', content:string}}}
 */
export async function run(ctx) {
  const rnd = typeof ctx?.random === 'function' ? ctx.random : Math.random;
  const quotes = readQuotes();
  const pool = quotes.length > 0 ? quotes : FALLBACK_LINES;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rnd() * pool.length)));

  return {
    ok: true,
    payload: { kind: 'text', content: pool[idx] },
  };
}

export default { available, run, readQuotes, FALLBACK_LINES };
