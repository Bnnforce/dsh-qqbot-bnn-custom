/**
 * central-store — 任务中心「IO 层」：配置读取 / 原子写 / last-run / 租约 / 流水。
 *
 * 约定（与《开发规则.md》一致）：
 *   · 所有写操作 = 同目录临时文件 + fsync + rename（断电/并发不会产生半截文件）；
 *   · 所有读操作都 try-catch，配置缺失/损坏 → 返回 null 交给上层兜底，**绝不阻塞启动**；
 *   · 该层**不含任何调度判断**（那是 central-core 的事），也不含任何定时器。
 */
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitizeTaskId } from '../central-core.mjs';

/** 原子写文本：`open(tmp)` → `write` → `fsync` → `rename` → `fsync(dir)`。
 *  目录 fsync 在某些 Android 共享存储上会 EPERM，**静默忽略**（rename 本身已是原子的）。 */
export function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  let fd;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, String(text));
    try { fsyncSync(fd); } catch { /* 某些文件系统不支持，忽略 */ }
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (err) {
    try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  try {
    const dirFd = openSync(dirname(file), 'r');
    try { fsyncSync(dirFd); } catch { /* ignore */ }
    closeSync(dirFd);
  } catch { /* 目录 fsync 不可用，忽略 */ }
}

/** 原子写 JSON（带缩进，便于人直接打开看）。失败返回 false，绝不抛。 */
export function writeJsonAtomic(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
    return true;
  } catch { return false; }
}

/** 读 JSON；不存在/损坏 → null。 */
export function readJsonSafe(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

/** 读文本；不存在/读不了 → null（用于"语法坏了但我要备份它"的场景）。 */
export function readTextSafe(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

/** 任务中心各路径。参数为 `taskCenterDir()` 的返回值（由外部传入，便于测试改道）。 */
export function pathsOf(dir) {
  const stateDir = join(dir, 'state');
  return {
    dir,
    config: join(dir, 'tasks.json'),
    readme: join(dir, 'README.md'),
    archiveDir: join(dir, '归档'),
    stateDir,
    lastRun: join(stateDir, 'last-run.json'),
    leaseDir: join(stateDir, 'lease'),
    journalDir: join(stateDir, 'journal'),
    journalIndex: join(stateDir, 'journal', 'index.json'),
    corruptDir: join(stateDir, 'corrupt'),
  };
}

/** 首次建目录（幂等）。 */
export function ensureDirs(paths) {
  try {
    for (const d of [paths.dir, paths.archiveDir, paths.stateDir, paths.leaseDir, paths.journalDir, paths.corruptDir]) {
      mkdirSync(d, { recursive: true });
    }
    return true;
  } catch { return false; }
}

/** last-run 结构：`{version, tasks: {taskId: {atMs, atText, dayKey, done, ok, nextEveryMs, note}}}`。 */
export function readLastRun(paths) {
  const raw = readJsonSafe(paths.lastRun);
  const tasks = raw?.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks) ? raw.tasks : {};
  const out = {};
  for (const [id, row] of Object.entries(tasks)) {
    if (!row || typeof row !== 'object') continue;
    out[sanitizeTaskId(id)] = {
      atMs: Number.isFinite(Number(row.atMs)) ? Number(row.atMs) : 0,
      atText: String(row.atText ?? ''),
      dayKey: String(row.dayKey ?? ''),
      done: row.done === true,
      ok: row.ok === true,
      // ★ 2026-11-05：本轮**承诺**的间隔。random 抖动模式必须持久化它，
      //   否则每 tick 重新随机会导致"永远凑不到期"（任务表现为不跑）。
      nextEveryMs: Number.isFinite(Number(row.nextEveryMs)) && Number(row.nextEveryMs) >= 1000
        ? Number(row.nextEveryMs) : 0,
      note: String(row.note ?? '').slice(0, 200),
    };
  }
  return { version: 1, tasks: out };
}

export function writeLastRun(paths, state) {
  return writeJsonAtomic(paths.lastRun, { version: 1, at: new Date().toISOString(), tasks: state?.tasks ?? {} });
}

/** 租约：跨宿主防双执行的唯一凭据。 */
export function leasePath(paths, taskId) {
  return join(paths.leaseDir, `${sanitizeTaskId(taskId)}.json`);
}

/**
 * 从租约 holder 里解析 pid。
 *
 * holder 由调用方拼成 `${owner}:ext:${process.pid}`（见 zz-central-scheduler.mjs），
 * 所以 pid 永远在最后一个冒号之后。解析不出/非法 → 0（表示"不确定"，交给调用方按原逻辑处理）。
 */
function pidOfHolder(holder) {
  const m = /(?:^|:)(\d{1,10})$/.exec(String(holder ?? '').trim());
  const pid = m ? Number(m[1]) : 0;
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * 判断「租约持有者是不是已经死了」—— 2026-11-05 新增，修重启僵尸租约盲区。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 真机事故（2026-11-05 18:18）：
 *   旧进程 pid=4569 在 18:18:25 正跑到一半时被重启，租约文件留在盘上（ttl=10 分钟）。
 *   新进程 18:18:44 启动时 `sweepStaleLeases` **只看时间到没到** → 判定"没过期、别人在跑"，
 *   于是 `ext-trim-agent-tools` 每 3 秒 `skip: leased`，白等 10 分钟。
 *   而它是**工具剪枝（安全面）**，这 10 分钟里新建的 QQ agent 不会被剪枝。
 *
 * 规则（主人 2026-11-05 明确要求）：
 *   · 解析不出 pid        → 不判死（按原时间逻辑走）
 *   · pid === 本进程      → 自己持有，当然不判死
 *   · `process.kill(pid,0)` 抛 **ESRCH** → 进程确实不存在，判死，返回该 pid
 *   · 抛 **EPERM** 或其它 → 无权限/无法确认，**信任租约时间**，不判死（安全兜底）
 *
 * 本函数**永不抛错**（探测失败一律按"还活着"处理，宁可多等也不误抢）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
function deadHolderPid(holder) {
  const pid = pidOfHolder(holder);
  if (!pid || pid === process.pid) return 0;
  try {
    process.kill(pid, 0); // 信号 0 = 纯探测，不真的发信号
    return 0; // 进程还活着
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : '';
    // EPERM = 无权限探测（跨用户进程）→ 保守处理，按时间逻辑走
    return code === 'ESRCH' ? pid : 0;
  }
}

/**
 * 抢租约：已存在且未过期 → 失败（返回 `{ok:false, holder}`）。
 *
 * ★ 2026-11-05 起增加「死进程租约」判定：即使时间没到，只要持锁进程已确认死亡，
 *   也立刻允许覆盖（返回 `{ok:true, staleFrom, deadPid}` 供调用方打 warn）。
 */
export function acquireLease(paths, taskId, holder, ttlMs, now) {
  const file = leasePath(paths, taskId);
  const cur = readJsonSafe(file);
  if (cur) {
    const startedAt = Number(cur.startedAt) || 0;
    const ttl = Number(cur.ttlMs) || 0;
    const expired = startedAt + Math.max(ttl, 1000) <= (Number(now) || Date.now());
    // 时间没过期时，再查一次「持有者是不是死了」（重启/被杀的僵尸租约）。
    const deadPid = expired ? 0 : deadHolderPid(cur.holder);
    if (!expired && !deadPid) return { ok: false, holder: cur };
    // 过期残留（进程被杀/崩溃）：直接覆盖，记一笔由调用方告警
    writeJsonAtomic(file, {
      taskId,
      holder,
      startedAt: Number(now) || Date.now(),
      ttlMs,
      stale: { from: cur.holder, startedAt, ...(deadPid ? { deadPid } : {}) },
    });
    return deadPid ? { ok: true, staleFrom: cur.holder, deadPid } : { ok: true, staleFrom: cur.holder };
  }
  writeJsonAtomic(file, { taskId, holder, startedAt: Number(now) || Date.now(), ttlMs });
  return { ok: true, staleFrom: '' };
}

export function releaseLease(paths, taskId) {
  try { unlinkSync(leasePath(paths, taskId)); return true; } catch { return false; }
}

/**
 * 启动时清掉所有过期租约；返回清理数量（0 表示正常）。
 *
 * ★ 2026-11-05：除「时间过期」外，也清「持锁进程已死」的僵尸租约。
 *   这样重启后不需要等满 ttl（10 分钟），进程一起来就能恢复被卡住的任务。
 */
export function sweepStaleLeases(paths, now) {
  let cleaned = 0;
  let files = [];
  try { files = readdirSync(paths.leaseDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  for (const f of files) {
    const file = join(paths.leaseDir, f);
    const cur = readJsonSafe(file);
    const startedAt = Number(cur?.startedAt) || 0;
    const ttl = Number(cur?.ttlMs) || 0;
    const expired = !cur || startedAt + Math.max(ttl, 1000) <= now || deadHolderPid(cur?.holder) > 0;
    if (expired) {
      try { unlinkSync(file); cleaned += 1; } catch { /* ignore */ }
    }
  }
  return cleaned;
}

/**
 * 追加一行流水（JSONL）。今天日期由调用方给（`YYYY-MM-DD`）。失败静默。
 *
 * ★ 2026-11-05 改（实测数据驱动）：原来一律「读全文 + 整体重写」，
 *   一天 550 条写下来累计 IO 约 **49MB**（30 天 1.48GB），最满时单次耗时 ~9ms。
 *   对手机共享存储来说这是不必要的磨损。现改为**混合策略**：
 *     · 文件 < `APPEND_THRESHOLD_BYTES`（约 512KB）→ 用 `appendFileSync` 直接追加（O(1)）；
 *     · 超过阈值 → 退回「读全文 + 原子重写」。
 *
 *   为什么还要保留重写路径：
 *     · 首次创建当天的文件需要 `mkdir` + 完整写入（追加对不存在文件也可用，但重写路径保证目录存在）；
 *     · **超过阈值时多半意味着反常**（正常一天约 76~92KB），此时宁可走原子重写，
 *       保证那一次落盘是完整的（追加若中途断电会留下半行，重写是 rename 原子替换）。
 *
 *   代价：追加不是原子的（断电可能留半行）——但 JSONL 是**逐行独立**的，
 *   读取侧本来就逐行 try/catch（`readLines`），半行会被跳过，不影响其它行。
 */
const APPEND_THRESHOLD_BYTES = 512 * 1024;

/**
 * ★ 2026-11-05（批次 3）：journal **分片轮转**阈值。
 *
 * 为什么加：原实现在文件超过 `APPEND_THRESHOLD_BYTES` 后走「读全文 + 原子重写」，
 * 而 12 条任务（含 4 个 3~5 秒的高频任务）实测一天能写到 **13MB / 9.5 万行**，
 * 越过 512KB 之后整整 23 小时里**每条流水都是 O(n²) 全量重写**（写放大 + 存储磨损）。
 *
 * 现在改为：单文件到 4MB 就 rename 成 `<day>-<n>.jsonl`，新文件从 `<day>.jsonl` 继续
 * `appendFileSync` —— 永远 O(1)，单文件也永远读得动。`pruneJournal` 已按天匹配（含分片后缀）。
 */
const JOURNAL_ROTATE_BYTES = 4 * 1024 * 1024;

export function appendJournal(paths, dayKey, row) {
  const file = join(paths.journalDir, `${dayKey}.jsonl`);
  const line = `${JSON.stringify(row)}\n`;
  try {
    mkdirSync(paths.journalDir, { recursive: true });
    let size = -1;
    try { size = statSync(file).size; } catch { size = -1; }
    // 到轮转阈值：把当前文件改名成 <day>-<n>.jsonl（取第一个空位），新文件从零开始追加
    if (size >= JOURNAL_ROTATE_BYTES) {
      let rotated = false;
      for (let n = 1; n <= 999; n += 1) {
        const target = join(paths.journalDir, `${dayKey}-${n}.jsonl`);
        try {
          if (existsSync(target)) continue;
          renameSync(file, target);
          rotated = true;
          break;
        } catch { break; }
      }
      // 轮转失败（权限/竞态）：退回直接追加 —— **绝不丢这一行**
      if (!rotated) {
        appendFileSync(file, line);
        return true;
      }
    }
    appendFileSync(file, line);
    return true;
  } catch { return false; }
}

/** 清理超过保留天数的流水文件（按文件名日期比较，无需读内容）。 */
export function pruneJournal(paths, keepDays, now) {
  const cutoff = new Date(Number(now) || Date.now());
  cutoff.setDate(cutoff.getDate() - Math.max(1, Number(keepDays) || 30));
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  let removed = 0;
  let files = [];
  try { files = readdirSync(paths.journalDir); } catch { return 0; }
  for (const f of files) {
    // 兼容分片文件名：`<day>.jsonl` 与 `<day>-<n>.jsonl`（2026-11-05 批次 3 起的轮转格式）
    const m = /^(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/.exec(f);
    if (!m || m[1] >= cutoffKey) continue;
    try { unlinkSync(join(paths.journalDir, f)); removed += 1; } catch { /* ignore */ }
  }
  return removed;
}

/** 把坏掉的配置文件快照到 `state/corrupt/`（**不覆盖用户原文**，只复制一份给排查用）。 */
export function snapshotCorrupt(paths, tag) {
  try {
    mkdirSync(paths.corruptDir, { recursive: true });
    const text = readTextSafe(paths.config);
    if (text === null) return '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(paths.corruptDir, `tasks.${tag}-${stamp}.json`);
    writeTextAtomic(dest, text);
    return dest;
  } catch { return ''; }
}

/** 配置文件的 mtime（热读判据：变了就重读，没变就不碰磁盘）。 */
export function configMtime(paths) {
  try { return statSync(paths.config).mtimeMs; } catch { return 0; }
}

/** last-run 文件的 mtime（跨宿主仲裁：对方写过就变了 → 必须重读）。 */
export function lastRunMtime(paths) {
  try { return statSync(paths.lastRun).mtimeMs; } catch { return 0; }
}

/** 文件是否存在（测试/诊断用）。 */
export function existsSafe(file) {
  try { return existsSync(file); } catch { return false; }
}
