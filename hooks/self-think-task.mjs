/**
 * self-think-task — 每日自主反思（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人要求：「一天至少强制触发一次反思自主」。
 *
 * 所以这个任务的核心不是「有值得反思的才写」，而是：
 *
 *   **每天必须写一条。** 哪怕今天没什么事，也要写「今天没什么特别的」。
 *
 * ── 为什么这么设计 ─────────────────────────────────────────────────────────
 *
 *   按时长触发（everyMs）在重启后会漏跑 —— 关掉一天就少一天。
 *   改按「自然日」判定：跑的时候看 lastDay 是不是今天，不是就补上。
 *   这样即使一天重启十次，也只会写一条，但**一定不会漏**。
 *
 * ── 反思从哪来（三层降级，绝不编造）──────────────────────────────────────
 *
 *   ① 宿主给了 LLM（env.kernel.get('llm')）→ 让它基于真实素材写一句反思
 *   ② LLM 拿不到 → 用结构化模板 + 真实统计（聊了几条、谁来了、她说了几句）
 *   ③ 连素材都没有 → 写「今天群里很安静」，这是事实，不是编的
 *
 * ── 写到哪里 ───────────────────────────────────────────────────────────────
 *
 *   Bot/自我/我的反思.md      ← 每天一条
 *   Bot/自我/我的变化记录.md  ← 只有真的变了才写
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { appendLogRotating } from '../lib/log-rotate.mjs';

const name = 'self-think-task';
const FALLBACK_MS = 24 * 3600_000;

const DSH_HOME = process.env.DSH_HOME
  || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';

/**
 * 工作区根（Bot/ 的上一级）。
 *
 * ⚠️ 用函数而不是常量：模块加载时 env 可能还没设好，
 *    而且测试要能改道到临时目录（常量会在 import 时定格）。
 */
function workspaceRoot() {
  return process.env.QQBOT_WORKSPACE
    || join(DSH_HOME, '..', '..', '..', '..', 'sdcard', 'DSH');
}
function selfDir() { return join(workspaceRoot(), 'Bot', '自我'); }
function reflectFile() { return join(selfDir(), '我的反思.md'); }

/** 记录「今天写过了」的标记文件（防重启漏跑/重复跑）。 */
const STATE_FILE = join(EXT_DATA, 'self-think-state.json');
const DIAG = join(EXT_DATA, 'self-think.log');

function diag(event, extra = {}) {
  try {
    appendLogRotating(DIAG, `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`, 256 * 1024);
  } catch { /* 日志失败不影响主链 */ }
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 读上次运行日。 */
function readState() {
  try {
    if (!existsSync(STATE_FILE)) return {};
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {};
  } catch { return {}; }
}

function writeState(obj) {
  try {
    mkdirSync(EXT_DATA, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/**
 * 收集今天的真实素材（纯算法，不调用任何模型）。
 *
 * @returns {{groups:number, msgs:number, people:number, topTopics:string[], herMsgs:number}}
 */
function collectToday() {
  const out = { groups: 0, msgs: 0, people: 0, topTopics: [], herMsgs: 0 };
  try {
    const base = join(EXT_DATA, 'msg-archive');
    if (!existsSync(base)) return out;

    const today = todayStr();
    const people = new Set();
    const wordFreq = new Map();

    for (const dir of readdirSync(base)) {
      if (!dir.startsWith('group_')) continue;
      const file = join(base, dir, `${today}.jsonl`);
      if (!existsSync(file)) continue;
      out.groups += 1;

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const j = JSON.parse(l);
          const s = String(j.s ?? '');
          if (s === 'self') { out.herMsgs += 1; continue; }
          out.msgs += 1;
          if (s) people.add(s);

          // 极简话题词：中文 2-4 字连续片段，过滤系统噪声
          const x = String(j.x ?? '');
          if (!x || /暂不能查看|\[群聊的聊天记录\]|=== 消息/.test(x)) continue;
          for (const run of x.match(/[\u4e00-\u9fa5]{2,4}/g) || []) {
            wordFreq.set(run, (wordFreq.get(run) || 0) + 1);
          }
        } catch { /* 跳过坏行 */ }
      }
    }

    out.people = people.size;
    out.topTopics = [...wordFreq.entries()]
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);
  } catch { /* 素材收集失败 → 用空值 */ }
  return out;
}

/**
 * 用 LLM 生成一句反思（拿不到就返回 null）。
 *
 * @param {object} kernel
 * @param {object} today
 * @returns {Promise<string|null>}
 */
async function reflectWithLLM(kernel, today) {
  try {
    const llm = kernel?.get?.('llm');
    if (!llm || typeof llm.stream !== 'function') return null;

    // 复用上游 distiller 的调用套路：找默认路由
    let route = null;
    try {
      const mod = await import('file:///data/user/0/com.dsharnessmobile.shell/files/home/.dsh/plugins/dsh-bnnbotbox/lib/memory/distiller.js');
      route = await mod.resolveDefaultRoute?.(llm);
    } catch { /* 拿不到路由就放弃 LLM */ }
    if (!route) {
      try {
        const list = await llm.list?.();
        route = Array.isArray(list) && list.length ? { provider: list[0].provider, model: list[0].model || list[0].id } : null;
      } catch { /* ignore */ }
    }
    if (!route) return null;

    const prompt = [
      '你是一个 QQ 群里的 AI，现在要写今天的一句反思。',
      '',
      '今天的真实情况：',
      `- 活跃群数：${today.groups}`,
      `- 群友消息：${today.msgs} 条`,
      `- 说过话的人：${today.people} 个`,
      `- 你自己说了：${today.herMsgs} 条`,
      today.topTopics.length ? `- 高频词：${today.topTopics.join('、')}` : '- 没有明显高频词',
      '',
      '要求：',
      '1. 只用一句话（30 字以内）',
      '2. 写你今天的**真实感受或发现**，不要编造具体事件',
      '3. 不要用「今天」「我发现」这种开头，直接说事',
      '4. 如果数据很少，就写「今天很安静」这类真实感受',
      '',
      '只输出那一句话，不要任何前缀。',
    ].join('\n');

    let text = '';
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: '你是一个诚实的自我反思者。只输出一句中文反思，不解释。',
      messages: [{
        id: `self-think-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:bnn-custom:self-think' },
      }],
      maxTokens: 120,
    });

    if (stream?.[Symbol.asyncIterator]) {
      for await (const chunk of stream) {
        text += typeof chunk === 'string' ? chunk : (chunk?.text ?? chunk?.delta?.text ?? '');
      }
    } else if (stream?.text) {
      text = String(stream.text);
    } else if (typeof stream === 'string') {
      text = stream;
    }

    const line = String(text).trim().split('\n').filter(Boolean)[0] || '';
    if (!line || line.length > 80) return null;
    return line.replace(/^["'「『]|["'」』]$/g, '').trim().slice(0, 60) || null;
  } catch {
    return null;
  }
}

/**
 * 无 LLM 时的结构化反思（只用真实数据，不编造）。
 */
function reflectWithTemplate(today) {
  if (today.msgs === 0) {
    return today.groups === 0
      ? '今天群里没动静，安静得有点不习惯。'
      : `今天 ${today.groups} 个群都没人说话，难得清静。`;
  }
  const parts = [];
  if (today.people > 0) parts.push(`${today.people} 个人在聊`);
  if (today.topTopics.length) parts.push(`反复提到「${today.topTopics[0]}」`);
  if (today.herMsgs > 0) parts.push(`我自己说了 ${today.herMsgs} 句`);
  return `今天 ${parts.join('，') || `群里有 ${today.msgs} 条消息`}。`;
}

/**
 * 把一条反思写进 我的反思.md（按日期分组，同一天追加不新建标题）。
 *
 * @param {string} date
 * @param {string} text
 * @returns {boolean}
 */
function appendReflection(date, text) {
  try {
    mkdirSync(selfDir(), { recursive: true });

    let content = '';
    if (existsSync(reflectFile())) {
      content = readFileSync(reflectFile(), 'utf8');
    }
    if (!content.trim()) {
      content = '# 我的反思\n\n> 每天至少写一条。这是我自己记的，不是别人要求的。\n';
    }

    const heading = `## ${date}`;
    const line = `- ${text}`;

    if (content.includes(heading)) {
      // 同一天已有标题 → 追加一条（但要防重复：完全相同就不写）
      if (content.includes(line)) return false;
      // 找到该标题段落的末尾（下一个 ## 或文件末尾）
      const idx = content.indexOf(heading);
      const rest = content.slice(idx + heading.length);
      const nextIdx = rest.indexOf('\n## ');
      if (nextIdx >= 0) {
        const before = content.slice(0, idx + heading.length + nextIdx);
        const after = content.slice(idx + heading.length + nextIdx);
        content = `${before.trimEnd()}\n${line}\n${after}`;
      } else {
        content = `${content.trimEnd()}\n${line}\n`;
      }
    } else {
      content = `${content.trimEnd()}\n\n${heading}\n${line}\n`;
    }

    writeFileSync(reflectFile(), content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 主流程。
 *
 * @param {object} env
 * @param {{force?:boolean}} opts
 */
async function thinkOnce(env = {}, opts = {}) {
  const today = todayStr();
  const state = readState();

  // ★ 自然日判定：今天写过就不写（除非 force）
  if (!opts.force && state.lastDay === today) {
    diag('skip', { reason: '今天已写过', lastDay: state.lastDay });
    return { ok: true, skipped: 'already-today' };
  }

  // ① 收集素材
  const facts = collectToday();

  // ② 生成反思：LLM 优先，降级模板
  let text = null;
  let source = 'template';
  try {
    text = await reflectWithLLM(env.kernel, facts);
    if (text) source = 'llm';
  } catch { /* ignore */ }
  if (!text) {
    text = reflectWithTemplate(facts);
    source = 'template';
  }

  // ③ 写入
  const wrote = appendReflection(today, text);

  // ④ 更新状态
  writeState({ lastDay: today, lastAt: new Date().toISOString(), source, facts, text });

  diag('wrote', { date: today, source, chars: text.length, msgs: facts.msgs, people: facts.people, wrote });

  return { ok: true, date: today, source, text, facts, wrote };
}

/** 供命令/手动调用与测试。 */
export { thinkOnce, collectToday };

/**
 * hook 入口（DSH 加载时调用一次）。
 *
 * 启动即跑一次（补上重启期间错过的），然后登记每日任务。
 */
export async function run(env) {
  // ① 启动先补一次（自然日判定，今天写过就跳过）
  try {
    const r = await thinkOnce(env);
    diag('boot', { date: r?.date, skipped: r?.skipped, source: r?.source });
  } catch (e) {
    diag('boot-error', { err: e instanceof Error ? e.message : String(e) });
  }

  // ② 登记每日任务（每小时检查一次；自然日判定保证每天恰好一条）
  registerWithFallback('self-think-task', () => thinkOnce(env), {
    env,
    fallbackMs: FALLBACK_MS,
    label: 'self-think-task',
    meta: { id: 'ext-self-think' },
  });
}

export default { name, run };
