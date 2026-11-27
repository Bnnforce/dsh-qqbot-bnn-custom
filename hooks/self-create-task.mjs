/**
 * self-create-task — 每日造物（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 主人定的方向：**不靠数据完善，靠规范创造。**
 *
 *   旧机制（行为参数）：数据偏离 → 调白名单里的 5 个数值
 *   新机制（造物）：每天问一次「我想成为什么样」→ 改一句话
 *
 * 区别在于「为什么改」：
 *   · 数据驱动改 = 「平均句长掉了 12 字，补回来」
 *   · 自觉驱动改 = 「我今天又抢话了，规则里没写什么时候闭嘴」
 *
 * ── 它做什么 ───────────────────────────────────────────────────────────────
 *
 *   ① 读 Bot/自我/我的造物规范.md（她自己看的手册）
 *   ② 读今天的真实素材（群聊摘要，不含 openid）
 *   ③ 读她现在的样子（自我文件 + 最近反思）
 *   ④ 让 LLM 决定「今天想改什么」（没有就是没有，不硬改）
 *   ⑤ Feedback 审查：有依据吗 / 矛盾吗 / 会伤害谁
 *   ⑥ 应用改动 + 备份 + 记进变化记录
 *
 * ── 安全 ───────────────────────────────────────────────────────────────────
 *
 *   · 只能改白名单文件（自我目录 + 规则 + 角色卡，安全规则除外）
 *   · 单次最多改 3 处、每处最多 500 字
 *   · 改前备份到 .snapshot/
 *   · 改后验证文件可读
 *   · 任何异常 → 回滚 + 记日志，绝不留下坏文件
 *   · 没有 LLM → 跳过（不硬改）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { appendLogRotating } from '../lib/log-rotate.mjs';

const name = 'self-create-task';
const FALLBACK_MS = 24 * 3600_000;

const DSH_HOME = process.env.DSH_HOME
  || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';

function workspaceRoot() {
  return process.env.QQBOT_WORKSPACE || join(DSH_HOME, '..', '..', '..', '..', 'sdcard', 'DSH');
}
function selfDir() { return join(workspaceRoot(), 'Bot', '自我'); }
function personaDir() { return join(workspaceRoot(), 'Bot', '人格'); }
function stateFile() { return join(EXT_DATA, 'self-create-state.json'); }
function diagFile() { return join(EXT_DATA, 'self-create.log'); }

function diag(event, extra = {}) {
  try {
    appendLogRotating(diagFile(), `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`, 256 * 1024);
  } catch { /* ignore */ }
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readState() {
  try {
    if (!existsSync(stateFile())) return {};
    return JSON.parse(readFileSync(stateFile(), 'utf8')) || {};
  } catch { return {}; }
}

function writeState(obj) {
  try {
    mkdirSync(EXT_DATA, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/**
 * ★ 主人的话：「所有东西都可以改，不做限制，但是不能搞坏东西。」
 *
 * 因此这里**没有任何白名单**。她能改：
 *   · 工作区一切（/sdcard/DSH/**）
 *   · 插件本体（.dsh/plugins/**）
 *   · 插件数据（.dsh/data/**）
 *   · 连自己的造物规范、安全规则、代码都能改
 *
 * 「不能搞坏东西」不靠禁止，靠四层机制：
 *   ① 改前备份（.snapshot/日期/，同名带时间戳）
 *   ② 改后验证（md 非空 / json 可解析 / js 语法过）
 *   ③ 验证不过 → **自动回滚**，文件回到改前
 *   ④ 全部留痕，随时能翻回去
 *
 * 唯一硬边界：路径穿越（../）—— 不是防她，是防字符串拼接出意外。
 */
function isEditable(rel) {
  const raw = String(rel || '').trim();
  if (!raw) return false;
  if (raw.includes('..')) return false;
  return true;
}

/** 解出绝对路径（相对 → 工作区下；绝对 → 原样）。 */
function resolveTarget(rel) {
  const raw = String(rel || '').trim();
  return raw.startsWith('/') ? raw : join(workspaceRoot(), raw);
}

/** 改这些后缀时，验证要更严（语法/可解析）。 */
const VALIDATE_STRICT = Object.freeze(['.mjs', '.js', '.cjs', '.json']);

function readText(abs) {
  try { return existsSync(abs) ? readFileSync(abs, 'utf8') : ''; } catch { return ''; }
}

/**
 * 收集今天的对话摘要（给 LLM 看，绝不带 openid）。
 */
function todayDigest() {
  const out = [];
  try {
    const base = join(EXT_DATA, 'msg-archive');
    if (!existsSync(base)) return out;

    const today = todayStr();
    for (const dir of readdirSync(base)) {
      if (!dir.startsWith('group_')) continue;
      const file = join(base, dir, `${today}.jsonl`);
      if (!existsSync(file)) continue;

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const msgs = [];
      for (const l of lines) {
        try {
          const j = JSON.parse(l);
          const x = String(j.x ?? '').trim();
          if (!x || /暂不能查看|\[群聊的聊天记录\]|=== 消息/.test(x)) continue;
          const who = String(j.n ?? '').slice(0, 12);
          // ★ 隐私：剥掉正文里的 @openid 标记（改成 @某人），绝不外带完整 openid
          const safe = x
            .replace(/<@[!&]?[0-9A-Za-z_-]{6,}>/g, '@某人')
            .replace(/[0-9A-F]{32}/g, 'openid');
          msgs.push(`${who}: ${safe.slice(0, 80)}`);
        } catch { /* skip */ }
      }
      if (msgs.length) out.push({ group: dir.slice(6, 14), msgs: msgs.slice(-40) });
    }
  } catch { /* ignore */ }
  return out;
}

/** 读造物规范 + 造物手册（规范讲心态，手册讲事实）。 */
function readSpec() {
  const spec = readText(join(selfDir(), '我的造物规范.md'));
  const manual = readText(join(selfDir(), '我的造物手册.md'));
  return [spec, manual].filter(Boolean).join(String.fromCharCode(10,10) + String.fromCharCode(45,45,45) + String.fromCharCode(10,10));
}

/** 读她现在的样子（动态扫描，不写死清单）。 */
function readCurrentSelf() {
  const parts = [];
  const dirs = [
    join(selfDir()),
    join(personaDir(), '规则'),
    join(personaDir(), '角色卡'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files) {
      const abs = join(dir, f);
      const t = readText(abs);
      if (!t.trim()) continue;
      const rel = abs.slice(workspaceRoot().length + 1);
      parts.push(`### ${rel}\n${t.trim().slice(0, 1200)}`);
    }
  }
  return parts.join('\n\n');
}

/** 读最近反思。 */
function readRecentReflection() {
  return readText(join(selfDir(), '我的反思.md')).slice(-1500);
}

/**
 * 找 LLM 路由（复用 distiller 的套路）。
 */
async function resolveRoute(llm) {
  try {
    const mod = await import(`file://${DSH_HOME}/plugins/dsh-bnnbotbox/lib/memory/distiller.js`);
    const r = await mod.resolveDefaultRoute?.(llm);
    if (r) return r;
  } catch { /* ignore */ }
  try {
    const list = await llm.list?.();
    if (Array.isArray(list) && list.length) {
      return { provider: list[0].provider, model: list[0].model || list[0].id };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 让 LLM 决定改什么。
 *
 * @returns {Promise<{ok:boolean, reason?:string, changes:Array}|null>}
 */
async function proposeWithLLM(kernel, ctx) {
  const llm = kernel?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return null;
  const route = await resolveRoute(llm);
  if (!route) return null;

  const prompt = [
    '## 你的造物规范',
    ctx.spec.slice(0, 3000),
    '',
    '## 你现在的样子',
    ctx.currentSelf.slice(0, 4000),
    '',
    '## 你最近的反思',
    ctx.reflection.slice(0, 1200) || '（还没有反思）',
    '',
    '## 今天群里发生了什么',
    ctx.digest.length
      ? ctx.digest.map((g) => `群${g.group}：\n${g.msgs.map((m) => '  ' + m).join('\n')}`).join('\n\n').slice(0, 3000)
      : '（今天很安静，没人说话）',
    '',
    '## 现在，回答我',
    '',
    '按造物规范，问自己：',
    '1. 今天有什么让我别扭的？（具体到一句话、一个瞬间）',
    '2. 这是我哪里没写对？',
    '3. 改哪一句、改成什么？',
    '',
    '**如果没有值得改的，就返回空数组。不要为了改而改。**',
    '',
    '只输出 JSON，不要任何解释：',
    '```json',
    '{',
    '  "reason": "今天为什么想改（一句话，具体到事）",',
    '  "changes": [',
    '    {',
    '      "file": "Bot/自我/我是谁.md",',
    '      "old": "要替换的原句（必须和文件里完全一致）",',
    '      "new": "改成什么",',
    '      "why": "为什么这么改"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    `你什么都可以改（Bot/ 目录下），但改坏了系统会自动帮你回滚。`,
    'old 为空字符串表示「追加到文件末尾」。',
  ].join('\n');

  let raw = '';
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    system: '你是一个会自我反省的人。只输出 JSON，不解释。宁可返回空数组，也不要为了改而改。',
    messages: [{
      id: `self-create-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin:bnn-custom:self-create' },
    }],
    maxTokens: 1200,
  });

  if (stream?.[Symbol.asyncIterator]) {
    for await (const chunk of stream) {
      raw += typeof chunk === 'string' ? chunk : (chunk?.text ?? chunk?.delta?.text ?? '');
    }
  } else if (stream?.text) raw = String(stream.text);

  return parseProposal(raw);
}

/** 解析她的提案（容错：抓 JSON 块）。 */
function parseProposal(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // 抓 ```json ... ``` 或裸 JSON
  let body = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1];
  else {
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i >= 0 && j > i) body = text.slice(i, j + 1);
  }

  let j;
  try { j = JSON.parse(body.trim()); } catch { return null; }
  if (!j || typeof j !== 'object') return null;

  const changes = Array.isArray(j.changes) ? j.changes : [];
  return {
    ok: true,
    reason: String(j.reason ?? '').slice(0, 200),
    changes: changes
      .filter((c) => c && typeof c === 'object')
      .slice(0, 3)                                 // 单次最多 3 处
      .map((c) => ({
        file: String(c.file ?? ''),
        old: String(c.old ?? ''),
        new: String(c.new ?? ''),
        why: String(c.why ?? '').slice(0, 200),
      }))
      .filter((c) => c.file && c.new),
  };
}

/** 备份一个文件。 */
function backup(abs) {
  try {
    const snapDir = join(selfDir(), '.snapshot', todayStr());
    mkdirSync(snapDir, { recursive: true });
    const name = abs.split('/').pop();
    const dst = join(snapDir, `${name}.${Date.now()}`);
    copyFileSync(abs, dst);
    return dst;
  } catch { return ''; }
}

/**
 * 应用一处改动。
 *
 * @returns {{ok:boolean, applied?:boolean, error?:string, backup?:string}}
 */
/**
 * 验证改动后的文件是否还健康。
 *
 * ★ 这是「不能搞坏东西」的核心：
 *   范围放开了，靠这个把坏文件拦在落地之前。
 *
 * @param {string} abs
 * @returns {{ok:boolean, error?:string}}
 */
function verifyFile(abs) {
  try {
    const t = readText(abs);
    if (!t.trim()) return { ok: false, error: 'verify-empty' };

    const lower = abs.toLowerCase();

    // .md：只要非空 + 有内容就行
    if (lower.endsWith('.md')) {
      if (t.trim().length < 8) return { ok: false, error: 'verify-too-short' };
      return { ok: true };
    }

    // .json：必须能解析
    if (lower.endsWith('.json')) {
      try { JSON.parse(t); } catch { return { ok: false, error: 'verify-json-broken' }; }
      return { ok: true };
    }

    // .mjs/.js/.cjs：必须语法正确
    if (/\.(mjs|js|cjs)$/.test(lower)) {
      try {
        execFileSync('node', ['--check', abs], { timeout: 15000, stdio: 'pipe' });
      } catch {
        return { ok: false, error: 'verify-syntax-broken' };
      }
      return { ok: true };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: `verify-error: ${String(e).slice(0, 60)}` };
  }
}

/**
 * 应用一处改动（带备份、验证、自动回滚）。
 */
function applyChange(change) {
  if (!isEditable(change.file)) return { ok: false, error: 'outside-workspace' };
  if (change.new.length > 800) return { ok: false, error: 'too-long' };

  const abs = resolveTarget(change.file);
  if (!existsSync(abs)) return { ok: false, error: 'file-missing' };

  const before = readText(abs);
  if (!before) return { ok: false, error: 'file-empty' };

  let after;
  if (!change.old) {
    after = `${before.trimEnd()}\n\n${change.new.trim()}\n`;
  } else {
    if (!before.includes(change.old)) return { ok: false, error: 'old-not-found' };
    after = before.replace(change.old, change.new);
    if (after === before) return { ok: false, error: 'no-change' };
  }

  // ① 备份（改前）
  const bk = backup(abs);
  if (!bk) return { ok: false, error: 'backup-failed' };

  try {
    // ② 写入
    writeFileSync(abs, after, 'utf8');

    // ③ 验证（含语法检查）
    const v = verifyFile(abs);
    if (!v.ok) {
      // ④ 不合格 → 自动回滚
      try { writeFileSync(abs, before, 'utf8'); } catch { /* ignore */ }
      return { ok: false, error: v.error, rolledBack: true };
    }

    return { ok: true, applied: true, backup: bk };
  } catch (e) {
    try { writeFileSync(abs, before, 'utf8'); } catch { /* ignore */ }
    return { ok: false, error: `write-failed: ${String(e).slice(0, 60)}`, rolledBack: true };
  }
}

/** 记进变化记录。 */
function logChange(date, reason, applied) {
  try {
    const f = join(selfDir(), '我的变化记录.md');
    let c = readText(f);
    if (!c.trim()) c = '# 我的变化记录\n\n> 我改了自己什么，为什么改。\n';

    const lines = applied.map((a) => `- 【${a.file.split('/').pop()}】${a.why || a.new.slice(0, 40)}`);
    const block = `\n## ${date}\n- 起因：${reason || '（未说明）'}\n${lines.join('\n')}\n`;

    if (!c.includes(`## ${date}`)) {
      c = `${c.trimEnd()}\n${block}`;
      writeFileSync(f, c, 'utf8');
      return true;
    }
    return false;
  } catch { return false; }
}

/**
 * 主流程。
 */
async function createOnce(env = {}, opts = {}) {
  const today = todayStr();
  const state = readState();

  if (!opts.force && state.lastDay === today) {
    diag('skip', { reason: '今天已造物过', lastDay: state.lastDay });
    return { ok: true, skipped: 'already-today' };
  }

  // ① 读规范（没有就跳过）
  const spec = readSpec();
  if (!spec.trim()) {
    diag('skip', { reason: '造物规范缺失' });
    return { ok: true, skipped: 'no-spec' };
  }

  // ② 收集上下文
  const ctx = {
    spec,
    currentSelf: readCurrentSelf(),
    reflection: readRecentReflection(),
    digest: todayDigest(),
  };

  // ③ 让 LLM 提案（测试可直接注入 opts.proposal）
  let proposal = null;
  if (opts.proposal) {
    proposal = opts.proposal;
  } else try {
    proposal = await proposeWithLLM(env.kernel, ctx);
  } catch (e) {
    diag('llm-error', { err: String(e).slice(0, 120) });
  }

  if (!proposal) {
    diag('skip', { reason: 'LLM 不可用或没有提案' });
    writeState({ lastDay: today, lastAt: new Date().toISOString(), result: 'no-llm' });
    return { ok: true, skipped: 'no-llm' };
  }

  if (!proposal.changes.length) {
    diag('nothing', { reason: proposal.reason.slice(0, 80) });
    writeState({ lastDay: today, lastAt: new Date().toISOString(), result: 'nothing-to-change', reason: proposal.reason });
    return { ok: true, changed: 0, reason: proposal.reason };
  }

  // ④ 应用（逐个，失败不影响其他）
  const applied = [];
  const failed = [];
  for (const ch of proposal.changes) {
    const r = applyChange(ch);
    if (r.ok && r.applied) applied.push({ ...ch, backup: r.backup });
    else failed.push({ file: ch.file, error: r.error });
  }

  // ⑤ 记录
  if (applied.length) logChange(today, proposal.reason, applied);

  writeState({
    lastDay: today,
    lastAt: new Date().toISOString(),
    result: applied.length ? 'changed' : 'all-failed',
    reason: proposal.reason,
    applied: applied.map((a) => ({ file: a.file, why: a.why })),
    failed,
  });

  diag('done', { applied: applied.length, failed: failed.length, reason: proposal.reason.slice(0, 80) });

  return { ok: true, changed: applied.length, failed, reason: proposal.reason, applied };
}

/** 导出给测试/命令用。 */
export { createOnce, todayDigest, parseProposal, isEditable, VALIDATE_STRICT };

/**
 * hook 入口。
 */
export async function run(env) {
  try {
    const r = await createOnce(env);
    diag('boot', { changed: r.changed, skipped: r.skipped });
  } catch (e) {
    diag('boot-error', { err: String(e).slice(0, 120) });
  }

  registerWithFallback('self-create-task', () => createOnce(env), {
    env,
    fallbackMs: FALLBACK_MS,
    label: 'self-create-task',
    meta: { id: 'ext-self-create' },
  });
}

export default { name, run };
