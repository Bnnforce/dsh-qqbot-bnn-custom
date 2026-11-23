#!/usr/bin/env node
/**
 * doctor.mjs — 环境自检：路径在哪、建好了没、素材缺什么
 *
 * 用法：
 *   node scripts/doctor.mjs            人类可读
 *   node scripts/doctor.mjs --json     机器可读（给脚本/CI 用）
 *   node scripts/doctor.mjs --fix      顺手把「必需目录」建出来（等价于启动时的自愈）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（真实需求，不是锦上添花）
 *
 *   本扩展包读写的目录是**我们的约定**，不是 QQ 官方要求的：
 *     {WORKSPACE_ROOT}/Bot/人格/、积分/、曲库/、美图库/ ...
 *
 *   别人装了这个包，机器上大概率一个都没有。虽然有 `hooks/zz-ensure-workspace.mjs`
 *   在启动时自动建「必需目录」，但：
 *     ① 建完没有可见反馈（只写进 workspace-dirs.json）—— 用户不知道发生了；
 *     ② **可选目录（曲库/美图库/事件库）不会自动建**，只给一句提示；
 *        用户不知道"点歌没反应"是因为曲库没放。
 *
 *   所以提供这个命令：一条命令看清楚「路径解析成了什么、哪些缺、缺了会怎样」。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 只读（除 --fix）：不删任何东西；--fix 也只 mkdir 必需目录，绝不覆盖/清空。
 */
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 只关心「本包真正会读」的环境变量。
 * 不列 DSH_SESSION_ID / DSH_WEB_URL 那类运行时内部变量 —— 对用户是噪音。
 */
const ENV_RE = /^(QQBOT_DATA_ROOT|BNN_[A-Z_]+|DSH_(?:EVENT_ROOT|IMAGE_ROOT|PERSONA_ROOT|PLAYLIST_CACHE_ROOT|POINTS_ROOT|SHOP_ROOT|SONG_ROOT|TASK_CENTER|VOICE_SAMPLE_ROOT))$/;

const asJson = process.argv.includes('--json');
const doFix = process.argv.includes('--fix');

const PKG = new URL('..', import.meta.url);

/* ── 加载本包的路径模块（失败就明确报错，别静默）── */
let paths, dirs;
try {
  paths = await import(new URL('lib/pack-paths.mjs', PKG).href);
  dirs = await import(new URL('lib/dirs.mjs', PKG).href);
} catch (err) {
  console.error('❌ 无法加载 lib/pack-paths.mjs 或 lib/dirs.mjs：', err?.message ?? err);
  process.exit(1);
}

const { DATA_ROOT, WORKSPACE_ROOT, EXT_ROOT, EXT_DATA, IS_PACK, PARTIAL_OVERRIDE } = paths;
const { DIR_MANIFEST, ensureWorkspaceDirs } = dirs;

/** 目录是否存在 + 是否为空 */
function probe(p) {
  let exists = false;
  let empty = null;
  let count = 0;
  try {
    exists = existsSync(p) && statSync(p).isDirectory();
  } catch { /* 读不到就当不存在 */ }
  if (exists) {
    try {
      const n = readdirSync(p).length;
      count = n;
      empty = n === 0;
    } catch { /* ignore */ }
  }
  return { exists, empty, count };
}

/* ── --fix：只建必需目录 ── */
let fixResult = null;
if (doFix) {
  try {
    fixResult = ensureWorkspaceDirs({ includeOptional: false });
  } catch (err) {
    fixResult = { created: [], existed: [], failed: ['(异常) ' + (err?.message ?? err)] };
  }
}

/* ── 收集 ── */
const rows = DIR_MANIFEST.map((item) => {
  const p = item.path;
  const st = probe(p);
  return {
    purpose: item.purpose,
    required: item.required,
    path: p,
    exists: st.exists,
    empty: st.empty,
    count: st.count,
    // 相对工作区显示，读起来更亲
    rel: String(p).startsWith(String(WORKSPACE_ROOT))
      ? '{WORKSPACE_ROOT}' + String(p).slice(String(WORKSPACE_ROOT).length)
      : p,
  };
});

const runtime = [
  { purpose: 'qqbot 数据根（.qqbot/ 所在）', path: DATA_ROOT },
  { purpose: '本扩展包位置', path: EXT_ROOT },
  { purpose: '扩展共享数据', path: EXT_DATA },
  { purpose: 'botplay 运行时副本', path: `${DATA_ROOT}/.qqbot-extensions/botplay` },
  { purpose: '运行时 lib 副本', path: `${DATA_ROOT}/.qqbot-extensions/lib` },
].map((r) => ({ ...r, ...probe(r.path) }));

/* ── 输出 ── */
if (asJson) {
  console.log(JSON.stringify({
    layout: { IS_PACK, PARTIAL_OVERRIDE, DATA_ROOT, WORKSPACE_ROOT, EXT_ROOT, EXT_DATA },
    fix: fixResult,
    dirs: rows,
    runtime,
    envOverrides: Object.fromEntries(
      Object.entries(process.env)
        .filter(([k]) => ENV_RE.test(k))
        .map(([k, v]) => [k, v]),
    ),
  }, null, 2));
  process.exit(0);
}

const line = (s = '') => console.log(s);
const mark = (ok, warnIfMissing = false) => (ok ? '✅' : warnIfMissing ? '⚠️ ' : '❌');

line('════════ 环境自检 ════════');
line();
line(`布局：${IS_PACK ? '扩展包（extension-packs/）' : '内置目录（.qqbot-extensions/）'}`);
line(`数据根 DATA_ROOT   = ${DATA_ROOT}`);
line(`工作区 WORKSPACE_ROOT = ${WORKSPACE_ROOT}`);
line(`本包    EXT_ROOT   = ${EXT_ROOT}`);
line(`共享数据 EXT_DATA  = ${EXT_DATA}`);

// ── 插件版本兼容（上游只有下限，上限是本包自己补的）────────────────
try {
  const { checkPluginCompat } = await import(new URL('lib/pure/version.mjs', PKG).href);
  const { homedir } = await import('node:os');
  const manifest = JSON.parse(readFileSync(new URL('qqbot-pack.json', PKG), 'utf8'));

  // 插件可能装在哪：环境变量 → DSH_PROFILE_DIR → 扫 ~/.dsh/profiles/*
  const candidates = [];
  if (process.env.QQBOT_PLUGIN_DIR) candidates.push(join(process.env.QQBOT_PLUGIN_DIR, 'package.json'));
  if (process.env.DSH_PROFILE_DIR) candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules/@zaofan/dsh-qqbot/package.json'));
  const profilesDir = join(homedir(), '.dsh', 'profiles');
  try {
    for (const name of readdirSync(profilesDir)) {
      candidates.push(join(profilesDir, name, 'node_modules/@zaofan/dsh-qqbot/package.json'));
    }
  } catch { /* 没有 profiles 目录就算了 */ }

  let pluginVersion = '';
  let foundAt = '';
  for (const c of candidates) {
    try {
      pluginVersion = String(JSON.parse(readFileSync(c, 'utf8')).version || '');
      if (pluginVersion) { foundAt = c; break; }
    } catch { /* 下一个 */ }
  }

  const compat = checkPluginCompat(pluginVersion, {
    min: manifest.minPluginVersion,
    max: manifest.maxPluginVersion,
    tested: manifest.testedWithPlugin,
  });
  const icon = compat.level === 'ok' ? '✅' : compat.level === 'warn' ? '⚠️ ' : '❌';
  line(`插件版本      = ${compat.actual || '(未找到)'}  ${icon}`);
  line(`                ${compat.message}`);
  line(`                声明：min=${manifest.minPluginVersion || '-'} tested=${manifest.testedWithPlugin || '-'} max=${manifest.maxPluginVersion || '-'}`);
  if (foundAt) line(`                位置：${foundAt}`);
} catch (e) {
  line(`插件版本      = (检查失败: ${String(e && e.message).slice(0, 80)})`);
}
if (PARTIAL_OVERRIDE) {
  line();
  line('⚠️  检测到「半改道」：设了 QQBOT_DATA_ROOT 但没设 BNN_WORKSPACE_ROOT。');
  line('    这通常说明在跑测试。为避免污染真实工作区，启动时不会建目录。');
  line('    测试请同时设置 BNN_WORKSPACE_ROOT。');
}

// 生效的环境变量覆盖
const envs = Object.entries(process.env)
  .filter(([k]) => ENV_RE.test(k))
  .sort(([a], [b]) => a.localeCompare(b));
if (envs.length) {
  line();
  line('生效的环境变量覆盖：');
  for (const [k, v] of envs) line(`  ${k} = ${v}`);
}

if (fixResult) {
  line();
  line('── --fix 结果 ──');
  if (fixResult.created.length) line(`  新建 ${fixResult.created.length} 个：${fixResult.created.join(', ')}`);
  if (fixResult.existed.length) line(`  已存在 ${fixResult.existed.length} 个`);
  if (fixResult.failed.length) line(`  ❌ 建不出来 ${fixResult.failed.length} 个：${fixResult.failed.join(', ')}`);
  if (!fixResult.created.length && !fixResult.failed.length) line('  没有需要新建的（都已在）');
}

line();
line('── 数据目录 ──');
line();
line(`  ${'状态'.padEnd(6)}${'类型'.padEnd(6)}${'路径'}`);
line(`  ${'─'.repeat(6)}${'─'.repeat(6)}${'─'.repeat(40)}`);
for (const r of rows) {
  const typeLabel = r.required ? '必需' : '可选';
  const st = r.exists
    ? (r.empty ? '⚠️ 空' : '✅ 有物')
    : (r.required ? '❌ 缺' : '· 未建');
  line(`  ${st.padEnd(6)}${typeLabel.padEnd(6)}${r.rel}`);
  line(`        ${r.purpose}${r.exists && !r.empty ? `（${r.count} 项）` : ''}`);
}

line();
line('── 运行时目录 ──');
line();
for (const r of runtime) {
  const st = r.exists ? (r.empty ? '⚠️ 空' : '✅') : '❌ 缺';
  line(`  ${st} ${r.purpose}`);
  line(`     ${r.path}`);
}

/* ── 结论 ── */
const missingRequired = rows.filter((r) => r.required && !r.exists);
const missingOptional = rows.filter((r) => !r.required && !r.exists);

line();
line('════════ 结论 ════════');
if (missingRequired.length) {
  line(`❌ 必需目录缺 ${missingRequired.length} 个 —— 相关功能会降级。`);
  line('   跑 `node scripts/doctor.mjs --fix` 自动创建（启动时也会自愈）。');
} else {
  line('✅ 必需目录齐全 —— 积分、人格、共享数据可以正常读写。');
}
if (missingOptional.length) {
  line();
  line(`⚠️  可选目录缺 ${missingOptional.length} 个（**不影响启动**，只影响对应玩法）：`);
  for (const r of missingOptional) line(`   · ${r.purpose} → ${r.rel}`);
  line();
  line('   想用哪个就把素材放进去，例如：');
  line('     · 点歌       → 往「曲库」放 .mp3（文件名建议「歌名 - 歌手.mp3」）');
  line('     · /来张图    → 往「美图库」放图片');
  line('     · 生活痕迹   → 往「事件库」放 .md 素材');
  line('   也可以把目录指到别处，用环境变量（见 README「目录约定」章节）。');
} else {
  line('✅ 可选素材目录也都有内容。');
}
