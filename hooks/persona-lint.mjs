/**
 * persona-lint — 角色/规则关键硬规则巡检（只告警，不阻断、不改文件）
 *
 * 2026-11-01：人格已改成目录结构（人格/规则/*.md + 人格/角色卡/*.md），
 * 旧实现还在读 `人格/角色卡.md` 这个已删除的扁平文件 ⇒ 永远报 8 条缺失。
 * 现在按目录读取：硬规则标记扫 规则/ 全部文件，角色卡单独检查是否为空/过短。
 *
 * 2026-11-04（阶段 1 收编）：**节律交给中央调度器**。
 *   原来这里自带 `setInterval(120s)`。现在只把 `lint(env)` 这个闭包登记给任务中心，
 *   多久跑一次由 `{工作区}/任务中心/tasks.json` 的 `ext-persona-lint`（everyMs=120000）决定。
 *   ① 启动时仍先跑一次（与之前行为一致，保证启动即有一份巡检结果）；
 *   ② 引擎缺席（被停用/加载失败）时**自动降级**回自带定时器 —— 绝不因为调度器出问题就丢巡检。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeJsonAtomic } from '../lib/pure/atomic.mjs';
import { join } from 'node:path';
import { EXT_DATA, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { PERSONA_ROOT } from '../lib/dirs.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { DATA_ROOT } from '../lib/pack-paths.mjs';

export const name = 'persona-lint';

const RULES_DIR = join(PERSONA_ROOT, '规则');
const CARDS_DIR = join(PERSONA_ROOT, '角色卡');
const OUT = join(EXT_DATA, 'persona-lint.json');
const MARKERS = ['P0', 'P0M', 'P0O', 'P0C', 'P0R', 'P0G', 'P0T', 'P1Q'];
/** 降级用的原节律（仅当任务中心没接管时才生效）。 */
const FALLBACK_MS = 120_000;

let lastSig = '';

function readDirText(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.includes('.bak'))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
  } catch { return ''; }
}

function lint(env) {
  try {
    const rulesText = readDirText(RULES_DIR);
    const cardsText = readDirText(CARDS_DIR);
    const missing = MARKERS.filter((m) => !new RegExp(`(^|[^A-Z0-9])${m}([^A-Z0-9]|$)`).test(rulesText));
    const cardCount = cardsText ? readdirSync(CARDS_DIR).filter((f) => f.endsWith('.md') && !f.includes('.bak')).length : 0;
    const row = {
      timestamp: new Date().toISOString(),
      roots: { rules: RULES_DIR, cards: CARDS_DIR },
      missing,
      chars: { rules: rulesText.length, cards: cardsText.length },
      cards: cardCount,
      emptyCards: cardCount === 0,
      status: missing.length || cardCount === 0 ? 'warn' : 'ok',
    };
    const sig = JSON.stringify([row.missing, row.cards, row.emptyCards]);
    if (sig !== lastSig) {
      mkdirSync(EXT_DATA, { recursive: true });
      writeJsonAtomic(OUT, row);
      lastSig = sig;
      if (missing.length) {
        try { (env.logger ?? env.log)?.warn?.(`[persona-lint] 规则目录缺少标记: ${missing.join(',')}`); } catch { /* ignore */ }
      }
      if (!cardCount) {
        try { (env.logger ?? env.log)?.warn?.('[persona-lint] 角色卡目录为空'); } catch { /* ignore */ }
      }
    }
    return row;
  } catch { return { status: 'error' }; }
}

export async function run(env) {
  lint(env); // 启动即跑一次（与收编前一致）
  // 节律交给中央调度器；引擎若缺席，3 秒后自动降级为自带 120s 定时器
  registerWithFallback('persona-lint', () => lint(env), {
    env, fallbackMs: FALLBACK_MS, label: 'persona-lint', meta: { id: 'ext-persona-lint' },
  });
  return 'ok';
}
export default { name, run };
