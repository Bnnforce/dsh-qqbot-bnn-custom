/**
 * her-taste-hint — 在她被问到「喜好 / 作品细节」时，定点提醒模型去查事实库
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个 hook（2026-11-16，主人追问"她真的会调用吗"之后）
 *
 * 问题：her_taste / work_fact 做完了，但**不代表模型会用**。
 *   实测查了真实会话：92 次工具调用里，这两个工具被调用 **0 次**。
 *   查下来有两条断链：
 *     ① 人格卡 §3.6 写了"被问喜好就调 her_taste"，但人格是**会话启动时的快照**，
 *        改文件不会进已运行的会话（后来用 persona-fp 内容指纹修了同步）；
 *     ② 光靠人格卡"嘱咐"本身就不牢靠 —— 它埋在 2.7 万字里，模型未必看见。
 *
 * 做法：**不去求模型记得**，而是在**用户真的问出那句话的当下**，紧贴着用户消息
 *   追加一条 system-reminder，直接点名该调哪个工具。
 *   · 每回合都跑（不像人格那样是快照）
 *   · 只在**命中提问句式**时才注入（不命中的对话零成本、零干扰）
 *   · 注入位置紧跟用户消息之后（注意力最强）
 *
 * 命中两类：
 *   A. 问她的喜好 → her_taste
 *   B. 问某个作品的细节（讲什么/谁唱的/结局/歌词…）→ work_fact
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'her-taste-hint';

/** A 类：问「她喜欢什么」。 */
const TASTE_PATTERNS = [
  /你(喜欢|爱|玩|听|看|吃)|你喜欢什么|你玩什么|你听什么|你看什么|你吃什么/,
  /(推荐|说说|讲讲).{0,6}(歌|番|动画|游戏|书)/,
  /(最近|平时).{0,4}(在)?(听|看|玩)什么/,
  /最(喜欢|爱)的(歌|番|动画|游戏|书|食物|东西)|最(喜欢|爱)哪(部|首|个|本|款)/,
  /你的(爱好|兴趣|口味|喜好)/,
  /有没有.{0,8}(推荐|好听|好看|好玩)/,
];

/** B 类：问某个作品的细节（这些最容易编）。 */
const WORK_PATTERNS = [
  /《[^》]{1,30}》/,
  /(这首歌|那首歌|这个歌|这歌).{0,10}(讲|说|唱|谁|什么)/,
  /(这部番|那部番|这个番|这部剧).{0,10}(讲|说|谁|什么|结局|完结)/,
  /(谁唱的|谁写的|谁做的|什么歌名|哪部番|哪首歌)/,
  /(歌词|结局|完结|完结了|大结局)/,
  /讲(了|的|下)?什么|说的是什么|讲的啥|内容是什么|讲了啥|讲些啥/,
  /(好看吗|好听吗|好玩吗|值得看|值得玩)/,
];

/** 诊断日志：哪条消息命中了、注入了哪类提示（重启后靠它验证链路通不通）。 */
function diag(tag, data) {
  try {
    const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'dsh-anti-ai-persona');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'her-taste-hint.log');
    appendLogRotating(p, `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`, 'utf8');
  } catch { /* 日志失败绝不影响主链路 */ }
}

const TASTE_HINT = [
  '<system-reminder>',
  '【工具提醒 · 此刻必须查证】',
  '用户正在问「她的喜好」。**先调用 `her_taste` 再回答**，不要凭印象编。',
  '· ⚠️ **一定要带 top 参数**：问"最喜欢/最爱的"传 top=3，一般问传 top=5',
  '  （工具会按偏好档 S>A>B>C 排好序、S 级带 ★，你直接照说前几个，不用自己挑）',
  '· 问歌 → her_taste(category="music", top=5)；问番 → category="anime", top=5',
  '· 问游戏 → category="game", top=5；问吃的 → "food"；问习惯 → "habit"',
  '· 只说前两三个，**不要一次倒完、不要照读清单**',
  '查完用她自己的语气说，像"想起来"而不是"念清单"。',
  '</system-reminder>',
].join('\n');

const WORK_HINT = [
  '<system-reminder>',
  '【工具提醒 · 此刻必须查证】',
  '用户在问具体作品的细节。**先调用 `work_fact(title="作品名")` 再回答**，',
  '模型对歌词/主角/结局/年份的记忆**系统性不可靠**，凭记忆答大概率编错。',
  '· 查到了：按卡里的内容说，**不补充卡里没有的细节**',
  '· 查不到：就说"记不清了""这个我没看过"，**绝对不要编**',
  '</system-reminder>',
].join('\n');

/** 取本轮用户消息纯文本。 */
function userTextOf(decision) {
  const parts = [];
  for (const m of (decision?.messages || [])) {
    if (!m || String(m.role || '') !== 'user') continue;
    const c = m.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text);
      }
    } else if (typeof c === 'string') parts.push(c);
  }
  return parts.join('\n');
}

/** 已经注入过就不再重复（同一条消息整轮只提醒一次）。 */
function alreadyHinted(decision) {
  for (const m of (decision?.messages || [])) {
    const c = m?.content;
    const txt = Array.isArray(c)
      ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
      : String(c || '');
    if (txt.includes('【工具提醒 · 此刻必须查证】')) return true;
  }
  return false;
}

function hintFor(text) {
  if (!text || text.length > 800) return '';   // 超长（多半是注入的规则块）忽略
  const t = text.trim();
  if (!t) return '';
  // 先判 B（更具体），再判 A
  for (const re of WORK_PATTERNS) if (re.test(t)) return WORK_HINT;
  for (const re of TASTE_PATTERNS) if (re.test(t)) return TASTE_HINT;
  return '';
}

export async function run(env) {
  const ctx = env?.ctx;
  if (!ctx?.on) return 'no-ctx';

  const handler = async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
      if (alreadyHinted(decision)) return decision;

      const text = userTextOf(decision);
      // 排掉人格/规则注入块（它们也带 role:user 但内容极长且是配置）
      if (text.includes('persona-fp:') || text.includes('安全规则（固定底座）')) return decision;

      const hint = hintFor(text);
      if (!hint) return decision;

      // 记录命中（重启后靠这条日志验证 hook 是否生效）
      const kind = hint === WORK_HINT ? 'work_fact' : 'her_taste';
      diag('HIT', { kind, text: text.slice(0, 60) });

      decision.messages.push({
        role: 'user',
        id: `her-taste-hint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: [{ type: 'text', text: hint }],
        source: { kind: 'qqbot:her-taste-hint', form: 'instructions' },
      });
      return decision;
    } catch {
      return decision;   // 失败关闭：绝不影响消息链路
    }
  };

  // 与 persona-group-overlay 用同一个事件（已验证可用）：agent/pre-step
  // prepend: true = 比人格注入更早跑，保证提示紧贴用户消息
  try {
    // ★ 2026-11-26 适配 1.13.26 契约 §8.2：
    //   ctx.on() 返回 disposer，不 dispose 热重载会不断累积（官方明确要求收尾）。
    const off = ctx.on('agent/pre-step', handler, { prepend: true });
    if (typeof off === 'function' && typeof env?.registerDispose === 'function') {
      env.registerDispose(off);
    }
    diag('BOOT', { msg: 'her-taste-hint 已挂载到 agent/pre-step' });
  } catch (e) {
    diag('BOOT-FAIL', { err: e instanceof Error ? e.message : String(e) });
    return 'no-hook';
  }
  return 'ok';
}

export default { name, run };
