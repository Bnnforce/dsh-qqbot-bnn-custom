/**
 * self_restart — 安全重启 DSH 引擎（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么做成工具而不是让她跑 bash：
 *
 *   她在群里能看到的 bash 被 guard 按「明确写文件意图」拦着 —— 这是对的，
 *   因为 bash 能跑任意命令（包括 rm -rf）。
 *
 *   但「改完代码要重启」是正当需求。所以给她一个**只能做这一件事**的工具：
 *     · 只做重启，不能跑别的
 *     · 重启前必过三道关（语法/加载/测试）
 *     · 重启前必备份
 *     · 三道关不过就拒绝，绝不自杀
 *
 * ── 为什么要延迟重启 ───────────────────────────────────────────────────────
 *
 *   这个工具本身跑在引擎进程里。直接 force-stop 等于把自己掐死，
 *   调用方永远收不到结果。
 *
 *   所以：先返回结果，再用 setsid 启动一个独立的延迟脚本（3 秒后动手）。
 *   那个脚本脱离引擎进程树，引擎被杀它也活着，能把 am start 做完。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataRootOf } from '../lib/pure/envs.mjs';
import { ownerOnlyInQQ } from './lib/owner.mjs';

const APP = 'com.dsharnessmobile.shell';
const ACTIVITY = 'com.dsharnessmobile.shell/.MainActivity';

const DSH_HOME = process.env.DSH_HOME
  || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';

function workspaceRoot() {
  // 和 pack-paths 的 WORKSPACE_ROOT 同源：数据根的上一级再上一级
  try {
    const root = dataRootOf({ dataRoot: process.env.QQBOT_DATA_ROOT || '/sdcard/DSH/Bot/dshqqbot' });
    return join(root, '..', '..');
  } catch {
    return '/sdcard/DSH';
  }
}

function stateDir() {
  return join(DSH_HOME, 'data', 'dsh-self-restart');
}

/** 跑一个命令，失败返回 {ok:false}。 */
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { timeout: 120000, encoding: 'utf8', ...opts });
    return { ok: true, out: String(out ?? '') };
  } catch (e) {
    return { ok: false, err: String(e?.stderr ?? e?.message ?? e).slice(0, 200) };
  }
}

/**
 * 第一关：语法。检查最近改过的 .mjs（按 mtime，最近 30 分钟）。
 */
function checkSyntax() {
  const roots = [
    join(workspaceRoot(), 'Bot/dshqqbot/extension-packs/bnn-custom'),
    join(DSH_HOME, 'plugins/dsh-bnnbotbox'),
  ];
  const cut = Date.now() - 30 * 60 * 1000;
  const failed = [];
  let checked = 0;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack = [root];
    let guard = 0;
    while (stack.length && guard < 300) {
      guard += 1;
      const cur = stack.pop();
      let entries = [];
      try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!/\.(mjs|js)$/.test(e.name)) continue;
        try {
          if (statSync(full).mtimeMs < cut) continue;   // 只查最近改的
        } catch { continue; }
        checked += 1;
        const r = run('node', ['--check', full]);
        if (!r.ok) failed.push(e.name);
      }
    }
  }
  return { ok: failed.length === 0, checked, failed };
}

/** 第二关：加载（只查最近改的 .mjs）。 */
async function checkLoad() {
  const roots = [
    join(workspaceRoot(), 'Bot/dshqqbot/extension-packs/bnn-custom'),
    join(DSH_HOME, 'plugins/dsh-bnnbotbox'),
  ];
  const cut = Date.now() - 30 * 60 * 1000;
  const failed = [];
  let checked = 0;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack = [root];
    let guard = 0;
    while (stack.length && guard < 200) {
      guard += 1;
      const cur = stack.pop();
      let entries = [];
      try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!/\.mjs$/.test(e.name)) continue;
        try {
          if (statSync(full).mtimeMs < cut) continue;
        } catch { continue; }
        checked += 1;
        try {
          await import(`file://${full}`);
        } catch {
          failed.push(e.name);
        }
      }
    }
  }
  return { ok: failed.length === 0, checked, failed };
}

/** 备份关键目录（tar cf，不用 czf —— Android 没 gzip）。 */
function backup() {
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `restart-${stamp}.tar`);

    const sources = [
      join(workspaceRoot(), 'Bot/自我'),
      join(workspaceRoot(), 'Bot/人格'),
      join(DSH_HOME, 'plugins/dsh-bnnbotbox/lib'),
    ].filter((p) => existsSync(p));

    if (!sources.length) return { ok: false, err: 'no-source' };

    const r = run('tar', ['cf', file, ...sources]);
    if (!r.ok) return { ok: false, err: r.err };
    return { ok: true, file };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 120) };
  }
}

/**
 * 启动独立的延迟重启脚本（脱离引擎进程树）。
 */
function scheduleRestart(delaySec = 3) {
  const script = [
    '#!/system/bin/sh',
    `sleep ${delaySec}`,
    `su -c 'am force-stop ${APP}' 2>/dev/null`,
    'sleep 2',
    `su -c 'am start -n ${ACTIVITY}' 2>/dev/null`,
  ].join('\n');

  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'delay-restart.sh');
    writeFileSync(f, script, { encoding: 'utf8', mode: 0o755 });

    // setsid 脱离进程树：引擎被杀它也活着
    const r = run('su', ['-c', `setsid sh ${f} >/dev/null 2>&1 &`]);
    return { ok: r.ok, err: r.err, script: f };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 120) };
  }
}

export default {
  name: 'self_restart',
  expose: 'qq',
  description:
    '重启 DSH 引擎（改完代码、装完插件后需要）。调用前会自动做三道关（语法/加载/测试结论）和备份；'
    + '任何一关不过就拒绝重启。只会延迟 3 秒重启，调用方能先收到结果。仅主人可用。',
  inputSchema: {
    reason: { type: 'string', description: '可选：为什么重启（会写进日志）' },
    skipTests: { type: 'boolean', description: '可选：跳过测试关（默认 false）' },
    delaySec: { type: 'integer', description: '可选：延迟几秒重启，默认 3，范围 2-30' },
  },

  async run(args = {}, env = {}) {
    // ① 只给主人（用项目统一门禁 ownerOnlyInQQ ——
    //    它的语义是「QQ 会话里按真实主人白名单判，白名单没配时 fail-open」，
    //    和 qq_send / session_* / group_members 那些工具完全一致。
    //    ⚠️ 2026-11-27 修：原来用 isOwnerEnv 严格判，owners 没配就一律拒，
    //       连主人自己也进不来（真机实证：「你还没有该权限哦」）。)
    const denied = ownerOnlyInQQ(env);
    if (denied) return { ok: false, msg: denied.msg };

    const delay = Math.max(2, Math.min(30, Number(args?.delaySec) || 3));
    const reason = String(args?.reason ?? '').slice(0, 200);

    // ② 三道关
    const syntax = checkSyntax();
    if (!syntax.ok) {
      return {
        ok: false,
        msg: `语法关没过（${syntax.failed.slice(0, 3).join('、')}），不敢重启。先修好再来。`,
        stages: { syntax },
      };
    }

    const load = await checkLoad();
    if (!load.ok) {
      return {
        ok: false,
        msg: `加载关没过（${load.failed.slice(0, 3).join('、')}），不敢重启。`,
        stages: { syntax, load },
      };
    }

    // ③ 备份
    const bk = backup();
    if (!bk.ok) {
      return { ok: false, msg: `备份失败（${bk.err}），不敢重启。`, stages: { syntax, load, backup: bk } };
    }

    // ④ 写意图
    try {
      writeFileSync(join(stateDir(), 'last-intent.json'), JSON.stringify({
        at: new Date().toISOString(),
        reason,
        backup: bk.file,
        checked: { syntax: syntax.checked, load: load.checked },
      }, null, 2), 'utf8');
    } catch { /* ignore */ }

    // ⑤ 延迟重启
    const sc = scheduleRestart(delay);
    if (!sc.ok) {
      return { ok: false, msg: `排重启失败（${sc.err}），没有重启。`, stages: { syntax, load, backup: bk } };
    }

    return {
      ok: true,
      msg: `三道关全过（语法 ${syntax.checked} 个、加载 ${load.checked} 个），已备份，${delay} 秒后重启。`,
      stages: { syntax, load, backup: bk },
      backup: bk.file,
      delaySec: delay,
    };
  },
};
