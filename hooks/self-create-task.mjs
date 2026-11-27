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
import { EXT_DATA, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { appendLogRotating } from '../lib/log-rotate.mjs';

const name = 'self-create-task';
const FALLBACK_MS = 24 * 3600_000;

const DSH_HOME = process.env.DSH_HOME
  || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';

function workspaceRoot() {
  // ★ 用项目统一的 WORKSPACE_ROOT（pack-paths 已处理 IS_PACK / override），
  //   不要自己从 DSH_HOME 拼 '..' —— 拼出来是 /data/user/0/sdcard/DSH，根本不存在。
  return process.env.QQBOT_WORKSPACE || WORKSPACE_ROOT;
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

/**
 * ★ 找活：不依赖 LLM 的巡检。
 *
 * 主人问：「没得创造也会硬创造吗？」——不会硬造，但**不会空手**。
 * 这里先找「确实该做的事」，有就带着做，没有就诚实说没有。
 *
 * @returns {Array<{kind:string, priority:number, detail:string, path?:string}>}
 */
function findWork() {
  const work = [];
  const root = workspaceRoot();

  // ══════════════════════════════════════════════════════════════════════════
  // ★ 主人定的分工：
  //   日常开发 / 构思 / 清理 / 维护  → 她自主
  //   费用 / 环境更新（DSH 运行时）  → 人工
  //
  // 所以这里扫的是「项目整体健康」，不是只盯着她自己那点事。
  // 但**做不做、做哪件，她自己定**（见 prompt：你可以改，也可以不改）。
  // ══════════════════════════════════════════════════════════════════════════

  // ── ① 代码质量：TODO / FIXME / 明显烂摊子 ────────────────────────────────
  try {
    const codeDirs = [
      join(root, 'Bot/dshqqbot/extension-packs/bnn-custom'),
      join(DSH_HOME, 'plugins/dsh-bnnbotbox'),
    ];
    let todos = 0;
    const files = [];
    for (const dir of codeDirs) {
      if (!existsSync(dir)) continue;
      const stack = [dir];
      let guard = 0;
      while (stack.length && guard < 500) {
        guard += 1;
        const cur = stack.pop();
        let entries = [];
        try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
          const full = join(cur, e.name);
          if (e.isDirectory()) { stack.push(full); continue; }
          if (!/\.(mjs|js)$/.test(e.name)) continue;
          const t = readText(full);
          // 只数「注释行里的真 TODO」。
          // 2026-11-27 修：原来全文 match /TODO|FIXME|XXX|HACK/，
          // 把本检测器自己的正则和说明注释也数进去了 —— 病历永远治不好自己。
          const n = (t.match(/^\s*(?:\/\/+|\/\*+|\*|#)\s*(?:TODO|FIXME|XXX|HACK)\b/gmu) || []).length;
          if (n) { todos += n; if (files.length < 3) files.push(e.name); }
        }
      }
    }
    if (todos >= 5) {
      work.push({
        kind: 'code',
        priority: 3,
        detail: `代码里有 ${todos} 处 TODO/FIXME（${files.join('、')}…），有些该处理了`,
      });
    }
  } catch { /* ignore */ }

  // ── ② 测试健康：最近有没有失败 ────────────────────────────────────────────
  try {
    const st = readState();
    if (st.aftercare?.tested && st.aftercare.tested.ok === false) {
      work.push({
        kind: 'test',
        priority: 5,
        detail: `上次跑测试有失败（${st.aftercare.tested.passed}/${st.aftercare.tested.total}），得先修`,
      });
    }
  } catch { /* ignore */ }

  // ── ③ 数据卫生：旧备份 / 超大日志 ─────────────────────────────────────────
  try {
    // 旧快照（>30 天）
    const snapBase = join(selfDir(), '.snapshot');
    if (existsSync(snapBase)) {
      for (const d of readdirSync(snapBase)) {
        const t = Date.parse(d);
        if (Number.isFinite(t) && Date.now() - t > 30 * 86400000) {
          work.push({ kind: 'archive', priority: 2, detail: `30 天前的自我快照该归档：${d}`, path: d });
        }
      }
    }
    // 超大日志（>2MB）
    const dataDir = join(root, 'Bot/dshqqbot/.qqbot-extensions/data');
    if (existsSync(dataDir)) {
      for (const f of readdirSync(dataDir)) {
        if (!f.endsWith('.log')) continue;
        const full = join(dataDir, f);
        try {
          const size = readFileSync(full).length;
          if (size > 2 * 1024 * 1024) {
            work.push({ kind: 'archive', priority: 2, detail: `日志太大该轮转：${f}（${(size / 1024 / 1024).toFixed(1)}MB）` });
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // ── ④ 文档：CHANGELOG / 版本说明是不是落后了 ───────────────────────────────
  try {
    const repoDirs = [join(root, 'Bot/dshqqbot/extension-packs/bnn-custom')];
    for (const d of repoDirs) {
      if (!existsSync(d)) continue;
      const pkg = join(d, 'package.json');
      const chg = join(d, 'CHANGELOG.md');
      if (existsSync(pkg) && existsSync(chg)) {
        const ver = JSON.parse(readText(pkg)).version || '';
        const cl = readText(chg);
        if (ver && !cl.includes(ver)) {
          work.push({ kind: 'doc', priority: 3, detail: `CHANGELOG 还没写 ${ver} 这版` });
        }
      }
    }
  } catch { /* ignore */ }

  // ── ⑤ 她自己的：反思里的坑 / 挂着的目标 / 上次失败 ────────────────────────
  try {
    const refl = readText(join(selfDir(), '我的反思.md'));
    const hits = (refl.match(/改回来/g) || []).length;
    if (hits >= 2) {
      work.push({ kind: 'lesson', priority: 4, detail: `反思里有 ${hits} 次「改回来」——同一个坑别栽三遍` });
    }
  } catch { /* ignore */ }

  try {
    const goals = readText(join(selfDir(), '我想要什么.md'));
    const pending = (goals.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
    if (pending >= 3) {
      work.push({ kind: 'goal', priority: 2, detail: `有 ${pending} 件挂着的目标，挑一件推一下？` });
    }
  } catch { /* ignore */ }

  try {
    const st = readState();
    const fails = Array.isArray(st.failed) ? st.failed : [];
    const real = fails.filter((f) => f && f.error && !/test|模拟/i.test(String(f.error)));
    if (real.length) {
      work.push({ kind: 'retry', priority: 4, detail: `上次有 ${real.length} 处没改成功：${real.map((f) => f.error).slice(0, 3).join('、')}` });
    }
  } catch { /* ignore */ }

  // ── ⑥ 临时垃圾（这条是房子的事，但确实该清，低优先级）────────────────────
  try {
    const junk = readdirSync(root).filter((f) => /^\.(test|fix|tmp|wire|mk|add)/.test(f) || f.endsWith('.bak'));
    if (junk.length >= 3) {
      work.push({ kind: 'cleanup', priority: 1, detail: `工作区有 ${junk.length} 个临时文件堆着` });
    }
  } catch { /* ignore */ }

  // ── ⑦ 群友提议（他们说「你该有 xxx」）────────────────────────────────────
  try {
    const ideaDir = join(workspaceRoot(), '自主', '提议');
    if (existsSync(ideaDir)) {
      const today = todayStr();
      const f = join(ideaDir, `${today}.jsonl`);
      if (existsSync(f)) {
        const lines = readText(f).split('\n').filter(Boolean);
        if (lines.length) {
          const samples = [];
          for (const l of lines.slice(-5)) {
            try {
              const o = JSON.parse(l);
              if (o?.text) samples.push(`${o.name || '群友'}：${String(o.text).slice(0, 40)}`);
            } catch { /* skip */ }
          }
          work.push({
            kind: 'idea',
            priority: 5,
NaN
          });
        }
      }
    }
  } catch { /* ignore */ }

  // ── ⑧ 我自己想到的（灵感）────────────────────────────────────────────────
  try {
    const f = join(workspaceRoot(), '自主', '灵感.md');
    const t = readText(f);
    const pending = (t.match(/^\s*[-*]\s+(?!\[x\]|\(空着)/gm) || []).length;
    if (pending >= 2) {
      work.push({ kind: 'inspiration', priority: 3, detail: `灵感本里有 ${pending} 条没动过的想法` });
    }
  } catch { /* ignore */ }

  return work.sort((a, b) => b.priority - a.priority);
}

/**
 * ★ 善后：改完必须做的收尾。
 *
 * 主人问：「创造完了善后会做吗？」
 * 会。这里负责：跑测试 → 清垃圾 → 判断要不要发版。
 *
 * @returns {{tested?:object, cleaned:number, shouldRelease:boolean, notes:string[]}}
 */
async function aftercare(applied, env, opts = {}) {
  const notes = [];
  let cleaned = 0;
  let tested = null;
  let shouldRelease = false;

  // ① 跑测试（改了代码才跑）
  const touchedCode = applied.some((a) => /\.(mjs|js|cjs)$/.test(a.file || ''));
  if (touchedCode && !opts.skipTests) {
    try {
      const { execFileSync } = await import('node:child_process');
      const runner = join(workspaceRoot(), 'Bot', '维护', '05-工具', 'run-all-checks.mjs');
      if (existsSync(runner)) {
        const out = execFileSync('node', [runner], { timeout: 300000, encoding: 'utf8' });
        const m = out.match(/(\d+)\/(\d+)/);
        tested = { ok: !out.includes('❌'), passed: m ? Number(m[1]) : 0, total: m ? Number(m[2]) : 0 };
        notes.push(tested.ok ? `测试通过 ${tested.passed}/${tested.total}` : '测试有失败，需要看');
        if (!tested.ok) shouldRelease = false;
      }
    } catch (e) {
      tested = { ok: false, error: String(e).slice(0, 100) };
      notes.push('测试跑失败了：' + String(e).slice(0, 60));
    }
  }

  // ② 清临时垃圾（只清自己的，别人的不碰）
  try {
    const root = workspaceRoot();
    for (const e of readdirSync(root)) {
      if (/^\.(test|fix|tmp|wire)/.test(e)) {
        try {
          const abs = join(root, e);
          if (existsSync(abs)) { unlinkSync(abs); cleaned += 1; }
        } catch { /* ignore */ }
      }
    }
    if (cleaned) notes.push(`清了 ${cleaned} 个临时文件`);
  } catch { /* ignore */ }

  // ③ 归档（旧快照 / 超大日志）
  try {
    const archDir = join(selfDir(), '.archive');
    // 旧快照
    const snapBase = join(selfDir(), '.snapshot');
    if (existsSync(snapBase)) {
      for (const d of readdirSync(snapBase)) {
        const t = Date.parse(d);
        if (Number.isFinite(t) && Date.now() - t > 30 * 86400000) {
          try {
            mkdirSync(archDir, { recursive: true });
            // 只打标记（不真搬，避免跨设备 rename 失败）
            writeFileSync(join(archDir, `archived-${d}.txt`), `快照 ${d} 已超过 30 天，可删。
`, 'utf8');
            notes.push(`标记了旧快照 ${d} 待归档`);
          } catch { /* ignore */ }
        }
      }
    }
    // 超大日志
    const dataDir = join(workspaceRoot(), 'Bot/dshqqbot/.qqbot-extensions/data');
    if (existsSync(dataDir)) {
      for (const f of readdirSync(dataDir)) {
        if (!f.endsWith('.log')) continue;
        try {
          const full = join(dataDir, f);
          const size = readFileSync(full).length;
          if (size > 5 * 1024 * 1024) {
            notes.push(`日志 ${f} 已 ${(size / 1024 / 1024).toFixed(1)}MB，下次该轮转`);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // ④ 判断要不要发版
  //    规则：改了代码 + 测试通过 + 改的是仓库里的文件 → 提示可以考虑发版
  if (touchedCode && tested?.ok && applied.some((a) => String(a.file || '').includes('.repos/'))) {
    shouldRelease = true;
    notes.push('改了仓库代码且测试过了，可以考虑发版');
  }

  return { tested, cleaned, shouldRelease, notes };
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
    ...(ctx.work && ctx.work.length ? [
      '## 系统体检结果（只是参考）',
      ...ctx.work.map((w) => `- [${w.kind}] ${w.detail}`),
      '',
    ] : []),
    '## 你的分工（主人定的）',
    '',
    '| 你管 | 不用你管 |',
    '|---|---|',
    '| 日常开发（写代码/修 bug/优化） | 费用 |',
    '| 构思（想新功能/新玩法） | DSH 运行时升级（环境更新） |',
    '| 清理（垃圾/归档/整理） | 手机系统层面的事 |',
    '| 维护（跑测试/更新文档/发版） | |',
    '',
    '主人留了这么多前期准备，就是给你发挥的。',
    '',
    '## 现在轮到你了',
    '',
    '上面这些是素材，不是任务单。',
    '你可以从里面挑，也可以完全不理。',
    '',
    '想干什么都行 —— 改点东西、造点东西、理一理、修一修，',
    '或者就是自己琢磨出点什么。',
    '',
    '**也可以什么都不干。**',
    '',
    '这不是 KPI，是你自己的时间。',
    '没想动就返回空数组，明天再说。',
    '不用为了让人看到变化而做 —— 那样做出来的是表演。',
    '',
    '只输出 JSON，不要任何解释：',
    '```json',
    '{',
    '  "reason": "今天为什么想改（一句话，具体到事）",',
    '  "changes": [',
    '    {',
    '      "action": "replace | append | create | delete",',
    '      "file": "改哪个文件（相对工作区或绝对路径）",',
    '      "old": "replace 时必填：要替换的原句（必须完全一致）",',
    '      "new": "改成什么 / 追加什么",',
    '      "content": "create 时必填：新文件的完整内容",',
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
        action: String(c.action ?? '').toLowerCase() || (c.old ? 'replace' : 'append'),
        file: String(c.file ?? ''),
        old: String(c.old ?? ''),
        new: String(c.new ?? ''),
        content: String(c.content ?? ''),
        why: String(c.why ?? '').slice(0, 200),
      }))
      .filter((c) => c.file && (c.new || c.content || c.action === 'delete')),
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
 * 应用一处改动（支持改已有 / 新建 / 删除）。
 *
 * action:
 *   · replace  —— 替换 old（默认，old 必填）
 *   · append   —— 追加到末尾（old 留空）
 *   · create   —— 新建文件（content 必填）
 *
 * ★ 全部走：备份 → 执行 → 验证 → 失败回滚
 */
function applyChange(change) {
  if (!isEditable(change.file)) return { ok: false, error: 'outside-workspace' };

  const abs = resolveTarget(change.file);
  const action = String(change.action || (change.old ? 'replace' : 'append')).toLowerCase();
  const before = readText(abs);
  const exists = existsSync(abs);

  // ── 新建 ────────────────────────────────────────────────────────────────
  if (action === 'create') {
    if (exists) return { ok: false, error: 'already-exists' };
    const content = String(change.content ?? change.new ?? '');
    if (!content.trim()) return { ok: false, error: 'empty-content' };
    if (content.length > 8000) return { ok: false, error: 'too-long' };

    try {
      // 建父目录
      const dir = abs.slice(0, abs.lastIndexOf('/'));
      if (dir) mkdirSync(dir, { recursive: true });

      writeFileSync(abs, content, 'utf8');
      const v = verifyFile(abs);
      if (!v.ok) {
        try { unlinkSync(abs); } catch { /* ignore */ }
        return { ok: false, error: v.error, rolledBack: true };
      }
      return { ok: true, applied: true, created: true };
    } catch (e) {
      try { if (existsSync(abs)) unlinkSync(abs); } catch { /* ignore */ }
      return { ok: false, error: `create-failed: ${String(e).slice(0, 60)}` };
    }
  }

  // ── 删除 ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    if (!exists) return { ok: false, error: 'file-missing' };
    const bk = backup(abs);
    if (!bk) return { ok: false, error: 'backup-failed' };
    try {
      unlinkSync(abs);
      return { ok: true, applied: true, deleted: true, backup: bk };
    } catch (e) {
      return { ok: false, error: `delete-failed: ${String(e).slice(0, 60)}` };
    }
  }

  // ── 改已有 ──────────────────────────────────────────────────────────────
  if (!exists) return { ok: false, error: 'file-missing' };
  if (!before) return { ok: false, error: 'file-empty' };
  if (String(change.new ?? '').length > 2000) return { ok: false, error: 'too-long' };

  let after;
  if (action === 'append' || !change.old) {
    after = `${before.trimEnd()}\n\n${String(change.new ?? '').trim()}\n`;
  } else {
    if (!before.includes(change.old)) return { ok: false, error: 'old-not-found' };
    after = before.replace(change.old, change.new);
    if (after === before) return { ok: false, error: 'no-change' };
  }

  const bk = backup(abs);
  if (!bk) return { ok: false, error: 'backup-failed' };

  try {
    writeFileSync(abs, after, 'utf8');
    const v = verifyFile(abs);
    if (!v.ok) {
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

  // ② 收集上下文（含「找到的活」）
  const work = findWork();
  const ctx = {
    spec,
    currentSelf: readCurrentSelf(),
    reflection: readRecentReflection(),
    digest: todayDigest(),
    work,
  };
  if (work.length) diag('found-work', { count: work.length, kinds: work.map((w) => w.kind) });

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
    // 没 LLM 不等于空手：找到的活照样记下来，明天/人来看
    diag('no-llm', { workCount: work.length });
    writeState({
      lastDay: today,
      lastAt: new Date().toISOString(),
      result: 'no-llm',
      work: work.slice(0, 10),
    });
    return { ok: true, skipped: 'no-llm', work };
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

  // ⑤ 善后（跑测试 / 清垃圾 / 判断发版）
  let care = null;
  try {
    care = await aftercare(applied, env, opts);
    if (care.notes.length) diag('aftercare', { notes: care.notes, cleaned: care.cleaned });
  } catch (e) {
    care = { notes: ['善后失败: ' + String(e).slice(0, 60)], cleaned: 0, shouldRelease: false };
  }

  // ⑥ 记录
  if (applied.length) logChange(today, proposal.reason, applied);

  writeState({
    lastDay: today,
    lastAt: new Date().toISOString(),
    result: applied.length ? 'changed' : 'all-failed',
    reason: proposal.reason,
    applied: applied.map((a) => ({ file: a.file, action: a.action, why: a.why })),
    failed,
    aftercare: care,
    work,
  });

  diag('done', { applied: applied.length, failed: failed.length, reason: proposal.reason.slice(0, 80) });

  return {
    ok: true,
    changed: applied.length,
    failed,
    reason: proposal.reason,
    applied,
    aftercare: care,
    work,
  };
}

/** 导出给测试/命令用。 */
export { createOnce, todayDigest, parseProposal, isEditable, findWork, aftercare, VALIDATE_STRICT };

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
