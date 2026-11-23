/**
 * zz-ensure-workspace — 首次运行自愈：把本包需要的工作区目录建出来
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个 hook（2026-11-20 开源可移植性）
 *
 * 本包要读写 `Bot/人格/`、`Bot/人格/积分`、`Bot/美图库`、`Bot/曲库` … 一批目录。
 * 这些是**本工作区的约定**，官方没有要求，所以别人装上这个包时：
 *
 *   · 这些目录一个都不存在
 *   · 读 → ENOENT / 空列表 → 功能静默失效，日志里看不出原因
 *   · 写 → 可能直接抛错，或者写到一个奇怪的地方
 *
 * 以前是靠「主人的机器上刚好都有」在跑。上架之后这条路必须堵上：
 *
 *   ① 这个 hook 在实例启动后跑一次，把 `required` 目录建出来（绝不删/不覆盖）
 *   ② 建不出来的（无权限等）记进诊断文件并告警，不阻塞
 *   ③ 同时把「哪些可选目录还缺」写下来，方便用户按需准备素材
 *
 * `optional` 目录（曲库、美图库、语音样本…）**不强制建** —— 空目录建出来反而
 * 让人以为已经配好了素材。它们由各自模块在用之前调 `ensureDir()` 按需创建。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA, WORKSPACE_ROOT, PARTIAL_OVERRIDE } from '../lib/pack-paths.mjs';
import { DIR_MANIFEST, ensureWorkspaceDirs, missingDirs } from '../lib/dirs.mjs';

export const name = 'ensure-workspace';

const OUT = join(EXT_DATA, 'workspace-dirs.json');

/** 只跑一次（同进程内多次 run 直接跳过）。 */
let done = false;

/** 落盘（Android FUSE 偶发 EPERM，重试几次）。 */
function writeRow(row) {
  try {
    mkdirSync(EXT_DATA, { recursive: true });
  } catch { /* 下面写也会失败，静默 */ }
  const text = JSON.stringify(row, null, 2);
  for (let i = 0; i < 6; i += 1) {
    try {
      writeFileSync(OUT, text, 'utf8');
      return;
    } catch { /* 重试 */ }
  }
}

/**
 * 清理原子写残留的临时文件。
 *
 * 原子写 = 「写 `<file>.tmp-<pid>-<rand>` → rename」。如果进程在两步之间被杀
 * （重启 / OOM / 手动强停），tmp 文件会留在原地。本机多次重启后攒了 5 个
 * 0 字节残留，被 preflight 判成「原子写异常」。
 *
 * 这里启动时清一遍：只删**超过 1 小时**的 tmp（正在写的不会被误删）。
 * 覆盖任务中心 state（含 lease 子目录）。
 *
 * @returns {string[]} 被删掉的路径
 */
function cleanStaleTmp(dir, maxAgeMs = 3600_000) {
  const removed = [];
  const walk = (d, depth = 0) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.tmp-/.test(e.name)) continue;
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) {
          unlinkSync(p);
          removed.push(p);
        }
      } catch { /* 单个删不掉不影响其它 */ }
    }
  };
  walk(dir);
  return removed;
}

export async function run(env) {
  // ★ 2026-11-23 工业化：同步 botplay 模块到上游位置
  //
  //   上游 botplay 加载器只认 {dataRoot}/.qqbot-extensions/botplay/（纯文件名），
  //   **不支持** extension-packs —— 是唯一的扩展点缺口。
  //   所以我们把扩展包里的模块复制过去（唯一真源仍在扩展包）。
  //
  //   ⚠️⚠️ 教训（2026-11-23 事故）：**绝不能 import 一个带顶层 process.exit 的脚本**。
  //      上一版 import 了 scripts/sync-botplay.mjs，它的顶层 process.exit(main())
  //      直接把 QQBot 进程杀掉 ⇒ 引擎一启动就炸。
  //      现在只用**纯函数 lib**（lib/pure/botplay-sync.mjs），零副作用。
  try {
    const { syncBotplayModules } = await import('../lib/pure/botplay-sync.mjs');
    const { dataRoot } = await import('../lib/roam/config.mjs');
    const r = syncBotplayModules({ dataRoot: dataRoot() });
    if (r.ok) {
      env?.logger?.info?.(`[botplay同步] ok 复制${r.copied} 跳过${r.skipped} 清理${r.removed} / 共${r.total}`);
    } else {
      env?.logger?.warn?.(`[botplay同步] 未完成 reason=${r.reason} missing=${r.missing.length}`);
    }
  } catch (e) {
    // 同步失败绝不影响启动
    env?.logger?.warn?.('[botplay同步] 异常已忽略: ' + String(e?.message || e));
  }

  if (done) return 'skipped';
  done = true;

  // 先清原子写残留（启动期一次，失败不影响主流程）
  let tmpCleaned = [];
  try {
    tmpCleaned = cleanStaleTmp(join(WORKSPACE_ROOT, 'Bot', '任务中心', 'state'));
  } catch { /* 任务中心不存在就算了 */ }

  // ★ 半改道保护：测试只设了 QQBOT_DATA_ROOT 却没设 BNN_WORKSPACE_ROOT 时，
  //   WORKSPACE_ROOT 仍指向真实工作区 —— 这时候去建目录就是在污染生产。
  //   此时只做诊断（列出缺什么），绝不写盘。
  if (PARTIAL_OVERRIDE) {
    const { missing } = missingDirs();
    writeRow({
      timestamp: new Date().toISOString(),
      status: 'skipped',
      note: '检测到 PARTIAL_OVERRIDE（只改了数据根、没改工作区根）：可能是测试配置。' +
        '为避免污染真实工作区，本次不创建任何目录。测试请同时设置 BNN_WORKSPACE_ROOT。',
      missing: missing.map((m) => `${m.path}  (${m.purpose})`),
    });
    return 'skipped';
  }

  const { created, existed, failed } = ensureWorkspaceDirs({ includeOptional: false });
  const { missing } = missingDirs();

  const missingRequired = missing.filter((m) => m.required);
  const missingOptional = missing.filter((m) => !m.required);
  const status = failed.length || missingRequired.length ? 'warn' : 'ok';

  const row = {
    timestamp: new Date().toISOString(),
    status,
    created,
    existed,
    failed,
    missingRequired: missingRequired.map((m) => `${m.path}  (${m.purpose})`),
    // 可选目录：只是提示用户"想用某功能就先备好这里"，不是错误
    hintOptional: missingOptional.map((m) => `${m.path}  (${m.purpose})`),
    manifestCount: DIR_MANIFEST.length,
    tmpCleaned: tmpCleaned.length,
    note: status === 'warn'
      ? '有必需目录建不出来（多半是权限问题），相关功能会降级。详见 failed/missingRequired。'
      : '工作区目录已就绪。可选目录缺料时按 hintOptional 自行准备素材即可。',
  };
  writeRow(row);

  if (status === 'warn') {
    // 只打日志，不主动发群消息 —— 避免启动期刷屏/误发。
    // 想看细节读 {dataRoot}/.qqbot-extensions/data/workspace-dirs.json
    const list = [...failed, ...missingRequired.map((m) => m.path)];
    try {
      console.warn(`[ensure-workspace] 必需目录建不出来 ${list.length} 个：${list.join(', ')}`);
    } catch { /* ignore */ }
  }

  return status;
}

export default { name, run };
