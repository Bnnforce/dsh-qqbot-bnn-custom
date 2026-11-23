/**
 * zz-central-scheduler — 任务中心「中央调度引擎」（扩展侧主引擎）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它是什么
 *   全项目唯一的时间裁判 + 唯一 setInterval 循环（1 秒粒度）。
 *   从 `{工作区}/任务中心/tasks.json` 读节律，把到期任务派发给**已注册的执行器**。
 *   执行器本体（各 hook 的业务逻辑）留在原文件，本引擎只接管"多久跑一次"。
 *
 * 它不是什么（重要，防止以后改坏）
 *   · **不接管原生定时器**：`@zaofan/dsh-qqbot` 的 scheduler / join-poll / idle-evictor
 *     等一律不碰（红线）。本引擎只驱动 `owner='ext'` 且**在本引擎登记过 run 键**的任务。
 *   · **不搬业务初始化**：各 hook `run(env)` 里的订阅、tools.guard 登记、缓存装载、
 *     registerDispose 全部留在原 hook。本引擎只负责"到点了，调一次那个已经建好的闭包"。
 *   · **不是任务队列**：同一任务的并发被 inFlight 挡住，但不同任务互不影响；
 *     长任务（LLM 调用）只写流水，不阻塞循环。
 *
 * 三种工作模式（tasks.json 的 `mode`，也可用 DSH_TASK_MODE 环境变量临时覆盖）
 *   · shadow（影子/dry-run，**阶段 0 默认**）：只判定、只写流水「would-run」，
 *     一次都不执行。用于在动真定时器之前，验证"到期判定"是否准确。
 *   · live：判定 + 抢租约 + 真执行 + 记账。
 *   · 任何模式下，任务 `enabled:false` 都直接跳过。
 *
 * 生命周期/防泄漏（与《开发规则.md》四·2 一致）
 *   · 全局单例：`globalThis[Symbol.for('dsh.taskcenter.engine.v1')]`。
 *     QQBot「保存连接设置」会"先拆后建"重建网关 → 会再跑一次 run()；
 *     单例保证第二个实例只**复用**、不叠加 timer。
 *   · `env.registerDispose` + 导出 `dispose()` 双通道清理（现有 hook 已是这个写法）。
 *   · dispose 幂等（`disposed` 守卫）；`timer.unref()` 不拖住进程退出。
 *   · tick 重入锁：`ticking` 布尔，`finally` 复位。
 */

import {
  ENGINE_SYMBOL_KEY, REGISTRY_SYMBOL_KEY, builtinDefaultConfig,
  computeDue, effectiveEveryMs, taskCenterDir, validateConfig, zonedParts,
} from '../lib/central-core.mjs';
import {
  acquireLease, appendJournal, configMtime, ensureDirs, lastRunMtime, pathsOf, pruneJournal,
  readJsonSafe, readLastRun, releaseLease, snapshotCorrupt, sweepStaleLeases,
  writeJsonAtomic, writeLastRun,
} from '../lib/io/central-store.mjs';

export const name = 'central-scheduler';

/** 没有 tasks.json 时写出的初始文件内容（人在 `任务中心/` 里看到的第一份东西）。 */
const SEED_CONFIG = {
  version: 1,
  // shadow = 只判定不执行（阶段 0）。验证完把这里改成 "live" 即生效。
  mode: 'shadow',
  timezone: 'Asia/Shanghai',
  tickMs: 1000,
  catchUpOnStart: true,
  journalKeepDays: 30,
  leaseTtlMs: 600000,
  tasks: builtinDefaultConfig().tasks,
};

const JOURNAL_ROTATE_MS = 60 * 60 * 1000;

function loggerOf(env) {
  return env?.logger && typeof env.logger === 'object' ? env.logger : console;
}

/** 全局执行器注册表（跨 hook 共享；Symbol 键保证与其它模块同名不冲突）。 */
function registryOf() {
  const key = Symbol.for(REGISTRY_SYMBOL_KEY);
  if (!globalThis[key] || typeof globalThis[key] !== 'object') globalThis[key] = new Map();
  return globalThis[key];
}

/**
 * 供其它 hook 调用：把"已建好的执行闭包"登记到引擎。
 *
 * @param {string} runKey   tasks.json 里 `run` 字段的值（唯一键）
 * @param {(reason: string) => Promise<unknown>|unknown} fn  到点时被调用一次
 * @param {{id?: string, note?: string}} [meta] 诊断用（不参与判定）
 * @returns {{ok: boolean, created: boolean}} `ok=false` 只在参数非法时出现；
 *   `created=false` 表示这个键之前已登记（网关重建/钩子重跑时正常，不覆盖、不报错）。
 */
export function registerExecutor(runKey, fn, meta = {}) {
  const key = String(runKey ?? '').trim();
  if (!key || typeof fn !== 'function') return { ok: false, created: false };
  const reg = registryOf();
  if (reg.has(key)) {
    // 网关"先拆后建"会重跑钩子；这里必须幂等 —— 覆盖会丢掉旧闭包持有的 env。
    try { console.info?.(`[任务中心] 执行器已存在，复用登记（不覆盖）: ${key}`); } catch { /* ignore */ }
    return { ok: true, created: false };
  }
  reg.set(key, { fn, meta });
  return { ok: true, created: true };
}

/** 当前是否有存活的引擎实例（hooks 用来判断要不要降级）。 */
export function isEngineAlive() {
  try {
    const engine = globalThis[Symbol.for(ENGINE_SYMBOL_KEY)];
    return Boolean(engine && engine.alive && !engine.disposed);
  } catch { return false; }
}

/**
 * 引擎是否处于**真接管**状态（存活 + live 模式）。
 *
 * 为什么必须区分 shadow：
 *   影子模式下引擎**只判定不执行**。若此时让 hook 也停掉自带定时器，
 *   业务巡检就真的停摆了 —— 那阶段 0 的观察期会变成"功能缺失期"。
 *   所以：影子期 = hook 照常自跑（行为与收编前完全一致），引擎并行记账做对照；
 *        切 live 后才真正由引擎驱动。这样观察期零风险。
 */
export function isEngineDriving() {
  try {
    const engine = globalThis[Symbol.for(ENGINE_SYMBOL_KEY)];
    return Boolean(engine && engine.alive && !engine.disposed && engine.mode === 'live');
  } catch { return false; }
}

/** 延迟裁决窗口：钩子按文件名排序，部分钩子（persona-*）在引擎之前加载，
 *  当场无法判断"引擎到底会不会起来"。这个值只用于"首次裁决"的日志措辞。 */
const FALLBACK_DECIDE_MS = 3000;

/** 自带定时器自清后的看门狗周期：低频检查引擎是否仍真接管，掉线则重新武装。 */
const FALLBACK_WATCHDOG_MS = 60_000;

/**
 * 「登记 + 必要时自动降级」—— 阶段 1 收编 hook 的标准写法。
 *
 * 为什么不是"延迟一段时间看引擎在不在"（那样很脆弱：前面的 hook 一旦慢，裁决就判早了）：
 *   **直接起自带定时器，但每次触发前先查 `isEngineDriving()`**：
 *     · 引擎已真接管（live）→ 自我清除，一次业务都不跑 → **不可能双执行**；
 *     · 引擎是 shadow 或压根没起 → 正常跑业务 → 行为与收编前完全一致。
 *   这样无论加载顺序如何、无论引擎几秒后才起来，最终态都正确，且不需要"猜时间"。
 *
 * 只有一处代价：live 模式下这个自带定时器会存活到它第一次被触发（≤ fallbackMs）才自清，
 * 期间不执行任何业务、只做一次判定。可接受。
 *
 * ★ 2026-11-05 补 P0：自清**不是永久的**。引擎之后可能崩溃 / 被 DSH_TASK_MODE 切回 shadow /
 *   tasks.json 改回 shadow —— 那时业务就再也没人驱动。所以自清后保留一个 60s 低频看门狗，
 *   发现 `isEngineDriving()` 变假就重新武装自带定时器并 warn 一次。
 *
 * @param {string} runKey
 * @param {Function} fn  业务闭包
 * @param {{fallbackMs:number, env?:any, label?:string, meta?:object}} opts
 * @returns {{ok:boolean, created:boolean}}
 */
export function registerWithFallback(runKey, fn, opts = {}) {
  const res = registerExecutor(runKey, fn, opts.meta ?? {});
  if (!res.ok) return res;
  const env = opts.env;
  const label = String(opts.label ?? runKey);
  const fallbackMs = Math.max(1000, Math.floor(Number(opts.fallbackMs) || 60_000));
  const lg = () => { try { return env?.logger ?? env?.log; } catch { return undefined; } };

  let disposed = false;
  let cleared = false;
  let timer = null;

  const stopFallback = () => {
    if (!timer) return;
    try { clearInterval(timer); } catch { /* ignore */ }
    timer = null;
  };

  /** 自带定时器的一拍：引擎真接管就自清，否则跑业务。 */
  const onFallbackTick = () => {
    try {
      if (isEngineDriving()) {
        if (!cleared) {
          cleared = true;
          stopFallback();
          try { lg()?.info?.(`[任务中心] ${label} 已由中央调度器接管 → 自带定时器自动清除（看门狗保留，引擎掉线会自动重新武装）`); } catch { /* ignore */ }
        }
        return; // 真接管后一次都不执行
      }
      // 影子期 / 引擎缺席：保持自跑（业务绝不降级）
      Promise.resolve(fn('自带定时器')).catch(() => {});
    } catch { /* 单次触发异常绝不影响下一次 */ }
  };

  /** 武装自带定时器（首次启动 / 引擎掉线后由看门狗调用）。 */
  const armFallback = () => {
    if (disposed) return;
    stopFallback();
    cleared = false;
    timer = setInterval(onFallbackTick, fallbackMs);
    timer.unref?.();
  };

  armFallback();

  /**
   * ★ 2026-11-05 修 P0：自清后的**看门狗**。
   *
   * 原来"引擎 live → 永久自清"的语义有个致命盲区：引擎之后若崩溃 / 被 DSH_TASK_MODE
   * 切回 shadow / tasks.json 改回 shadow，业务就再也没人驱动，而且一条日志都没有。
   * 现在自清后保留一个低频看门狗：
   *   · `isEngineDriving()` 仍为真 → 什么都不做（成本 = 每分钟一次布尔判断）；
   *   · 引擎不再驱动 → **重新武装**自带定时器 + warn 一次（每个掉线周期只报一次：
   *     重新武装后 `cleared=false`，看门狗自然静默，直到它下一次再被自清）。
   * 看门狗 timer 同样 `unref()` 并登记 `registerDispose`，绝不拖住进程 / 泄漏。
   */
  const watchdog = setInterval(() => {
    try {
      if (disposed || !cleared) return;
      if (isEngineDriving()) return;
      const alive = isEngineAlive();
      armFallback();
      try {
        lg()?.warn?.(
          `[任务中心] ${label} 检测到中央调度器${alive ? '已不再 live（被切回 shadow？）' : '已停止运行'} → 重新启用自带 ${Math.round(fallbackMs / 1000)}s 定时器（业务恢复）`,
        );
      } catch { /* ignore */ }
    } catch { /* 看门狗自身绝不抛错 */ }
  }, FALLBACK_WATCHDOG_MS);
  watchdog.unref?.();

  try {
    env?.registerDispose?.(() => {
      disposed = true;
      stopFallback();
      try { clearInterval(watchdog); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  // 只做一次启动后的状态说明（不参与任何判定，纯日志）
  const decider = setTimeout(() => {
    try {
      if (isEngineDriving()) {
        try { lg()?.info?.(`[任务中心] ${label} 已由中央调度器接管（节律见 任务中心/tasks.json）`); } catch { /* ignore */ }
      } else {
        const why = isEngineAlive() ? '引擎处于影子模式（只判定不执行）' : '引擎未启动';
        try { lg()?.warn?.(`[任务中心] ${why} → ${label} 保持自带 ${Math.round(fallbackMs / 1000)}s 定时器（业务不降级）`); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }, FALLBACK_DECIDE_MS);
  decider.unref?.();
  return res;
}

export async function run(env) {
  const logger = loggerOf(env);
  const warn = (m) => { try { logger.warn?.(m); } catch { /* ignore */ } };
  const info = (m) => { try { logger.info?.(m); } catch { /* ignore */ } };

  // ── 单例：第二次进入（网关重建 / 热重载）只复用，不新建循环 ─────────────
  const engineKey = Symbol.for(ENGINE_SYMBOL_KEY);
  const existing = globalThis[engineKey];
  if (existing && existing.alive) {
    info('[任务中心] 引擎已在运行 → 复用既有实例（不重复注册、不叠加定时器）');
    return 'ok(reused)';
  }

  const dir = taskCenterDir();
  const paths = pathsOf(dir);
  ensureDirs(paths);

  /** 影子模式 token 去重集合（同一到期只记一次 would-run，避免每秒刷日志）。 */
  const shadowTokens = new Set();
  /** 同任务并发锁。 */
  const inflight = new Set();

  const engine = {
    alive: true,
    disposed: false,
    dir,
    paths,
    tickMs: 1000,
    mode: 'shadow',
    config: null,
    configMtime: -1,
    ticking: false,
    timer: undefined,
    lastJournalRotateMs: 0,
    startedAt: Date.now(),
    stats: { ticks: 0, due: 0, ran: 0, skipped: 0, failed: 0, lastRunAt: 0 },
    registry: registryOf(),
    shadowTokens,
    /** 未注册执行器的 run 键（只告警一次，避免每轮刷屏）。 */
    missingRunWarned: new Set(),
    inflight,
  };
  globalThis[engineKey] = engine;

  // ── 配置装载：缺文件 → 播种；坏文件 → 快照 + 内置默认（绝不停摆） ────────
  //   ★ 2026-11-05 修 P0：单条非法**不再整份回退**（validateConfig 内部逐条丢弃、
  //     只保留合法任务）。这里只负责两件事：坏文件快照 + 回退时把"上次生效的 mode"
  //     交给 validateConfig 继承，绝不静默降级成 shadow。
  const loadConfig = (force = false) => {
    const mtime = configMtime(paths);
    if (!force && mtime === engine.configMtime && engine.config) return engine.config;

    const raw = readJsonSafe(paths.config);
    if (!raw) {
      if (mtime > 0) {
        // 文件存在但解析不了：快照一份给排查，**绝不覆盖用户原文**
        const snap = snapshotCorrupt(paths, 'parse-fail');
        warn(`[任务中心] tasks.json 解析失败 → 已快照到 ${snap || '(快照失败)'}，本次回退内置默认（原文件保持不动）`);
      } else {
        // 文件根本不存在：播种一份，让 `任务中心/` 一打开就有东西看
        if (writeJsonAtomic(paths.config, SEED_CONFIG)) {
          info(`[任务中心] 未找到 tasks.json → 已播种初始配置: ${paths.config}`);
        }
      }
    }
    /**
     * ★ 注意：解析失败时 `raw` 是 null，**不能拿 SEED_CONFIG 顶替** ——
     *   SEED_CONFIG.mode 是 shadow，顶替会让引擎静默降级、所有任务停跑且无告警。
     *   改为：把上次生效的 mode 作为 fallbackMode 传下去；启动期没有上次值，
     *   validateConfig 会保持 live 并 warn。
     */
    const parseFailed = !raw && mtime > 0;
    const result = validateConfig(parseFailed ? null : (raw ?? SEED_CONFIG), {
      fallbackMode: parseFailed ? engine.config?.mode : undefined,
    });
    for (const w of result.warnings) warn(`[任务中心] 配置告警：${w}`);
    for (const e of result.errors) warn(`[任务中心] 配置错误：${e}`);

    // ── 如实说明"到底丢了什么、会停什么"（旧文案写"该任务已跳过，其余照常"，与事实相反）──
    if (result.droppedCount > 0) {
      const lost = result.dropped.map((d) => d.id).join('、');
      warn(`[任务中心] 已丢弃 ${result.droppedCount} 条任务：${lost}`);
      warn(`[任务中心] ⚠ 以上被丢弃的任务不会执行；其中自带定时器已自清（已由引擎接管）的业务会一并停摆，直到 tasks.json 修好（当前保留 ${result.config.tasks.length} 条任务继续运行）`);
    }
    if (result.fallback) {
      warn(`[任务中心] 整份配置回退内置默认：${result.config.tasks.length} 条任务，mode=${result.config.mode}（遵循原配置 mode，不静默降级）`);
    }

    const cfg = result.config;
    const modeOverride = String(process.env.DSH_TASK_MODE ?? '').trim();
    if (modeOverride === 'live' || modeOverride === 'shadow') {
      if (modeOverride !== cfg.mode) info(`[任务中心] 模式被环境变量覆盖：${cfg.mode} → ${modeOverride}`);
      cfg.mode = modeOverride;
    }
    engine.config = cfg;
    engine.configMtime = mtime;
    engine.tickMs = cfg.tickMs || 1000;
    engine.mode = cfg.mode;
    return cfg;
  };

  const cfg = loadConfig(true);

  // ── last-run 必须在 tick 里按 mtime 重读（**跨宿主仲裁的前提**）──────────
  //    插件侧（owner='plugin'）是同一进程里的另一个模块，它会写这份文件；
  //    若本引擎一直用启动时读进内存的副本，就永远看不见对方已执行的记录 → 双执行。
  //    用 mtime 缓存：没变就不读盘（每秒 3 次 stat 的开销可忽略），变了就重读。
  const lastRunRef = { state: readLastRun(paths), mtime: lastRunMtime(paths) };
  const refreshLastRun = (force = false) => {
    const mt = lastRunMtime(paths);
    if (!force && mt === lastRunRef.mtime) return lastRunRef.state;
    lastRunRef.state = readLastRun(paths);
    lastRunRef.mtime = mt;
    return lastRunRef.state;
  };

  // ── 启动维护：清过期租约 + 播种 interval 基准 ───────────────────────────
  const now0 = Date.now();
  const dayKey0 = zonedParts(now0, cfg.timezone).dayKey;
  const lastRun = refreshLastRun(true);

  const swept = sweepStaleLeases(paths, now0);
  if (swept > 0) warn(`[任务中心] 清理了 ${swept} 个过期租约（上次进程异常退出残留）`);

  let seeded = 0;
  for (const task of cfg.tasks) {
    if (task.kind !== 'interval') continue;
    const cur = lastRun.tasks[task.id];
    if (cur && Number(cur.atMs) > 0) continue;
    lastRun.tasks[task.id] = {
      atMs: now0, atText: new Date(now0).toISOString(), dayKey: dayKey0,
      done: false, ok: true, note: '启动播种基准',
    };
    seeded += 1;
  }
  if (seeded > 0) {
    writeLastRun(paths, lastRun);
    lastRunRef.mtime = lastRunMtime(paths);
    info(`[任务中心] 已为 ${seeded} 个间隔任务播种首次基准（本轮不触发；各 hook 启动时本就会自跑一次）`);
  }

  const journal = (row) => {
    appendJournal(paths, zonedParts(Date.now(), engine.config?.timezone).dayKey, row);
  };

  /**
   * 执行单个任务。**永不抛错**；失败只记流水 + 告警。
   *
   * @param {object} task
   * @param {object} dueInfo
   * @param {number} anchorNow  **判定用的 tick 时刻**（必传）
   *
   * ★ 2026-11-05 为什么必须由 tick 传 anchorNow（第 2 次修，第 1 次修错了）：
   *   第 1 次修把 `atMs` 从"完成时刻"改成"execTask 里的开始时刻"，方向对但**锚点仍不对** ——
   *   `execTask` 是 `void Promise.resolve().then(...)` 异步派发的，它内部的 `Date.now()`
   *   比 tick 判定用的 `now` **晚几毫秒**（实测 δ 约 2~10ms）。于是：
   *     tick now = T，atMs = T+δ
   *     T+3000 那一轮：elapsed = 3000 - δ < 3000  → **不给触发**
   *     T+4000 那一轮：elapsed = 4000 - δ ≥ 3000  → 才触发
   *   结果就是**每个任务都稳定多等 1 个 tick**。真机实测完全吻合这条规律：
   *     trim/guard 配 3000 → 实测 p50 4000（+1 tick）
   *     model-default/heartbeat-bridge 配 5000 → 实测 p50 6000（+1 tick）
   *     persona-from-file 配 30000 → 实测 p50 30717（+0.7 tick）
   *   所以锚点必须严格等于**判定时刻 `now`**，与执行何时开始无关。
   */
  const execTask = async (task, dueInfo, anchorNow) => {
    const entry = engine.registry.get(task.run);
    if (!entry) {
      engine.stats.skipped += 1;
      // 未注册执行器只在**首次**告警一次（避免每轮刷屏），但流水每次都记。
      const missKey = task.run;
      if (!engine.missingRunWarned.has(missKey)) {
        engine.missingRunWarned.add(missKey);
        warn(`[任务中心] 任务 ${task.id} 的 run="${task.run}" 没有对应执行器 → 本次及后续均跳过（检查该 hook 是否 registerWithFallback 成功）`);
      }
      journal({
        ts: Date.now(), taskId: task.id, owner: task.owner, run: task.run,
        event: 'skip', reason: 'unknown-run',
        note: 'tasks.json 的 run 键没有对应执行器（检查该 hook 是否已 registerExecutor）',
      });
      return;
    }

    // 影子模式：只记账、不执行。也写 last-run，否则基准不动 → 每秒都"到期"刷屏。
    if (engine.mode === 'shadow') {
      engine.stats.due += 1;
      journal({
        ts: Date.now(), taskId: task.id, owner: task.owner, run: task.run,
        event: 'would-run', reason: dueInfo.reason, mode: 'shadow',
      });
      const nowMs = Date.now();
      const stShadow = refreshLastRun(true);
      stShadow.tasks[task.id] = {
        // 影子模式同样用判定时刻做锚点（口径与 live 一致，否则影子测出的节律会偏）。
        atMs: anchorNow, atText: new Date(anchorNow).toISOString(),
        dayKey: zonedParts(nowMs, engine.config.timezone).dayKey,
        done: task.kind === 'once', ok: true, note: `影子里程（未执行）: ${dueInfo.reason}`,
      };
      writeLastRun(paths, stShadow);
      lastRunRef.mtime = lastRunMtime(paths);
      return;
    }

    // live：抢租约（跨宿主防双执行的唯一凭据）
    const holder = `${task.owner}:ext:${process.pid}`;
    const lease = acquireLease(paths, task.id, holder, engine.config.leaseTtlMs, Date.now());
    if (!lease.ok) {
      engine.stats.skipped += 1;
      journal({
        ts: Date.now(), taskId: task.id, owner: task.owner, run: task.run,
        event: 'skip', reason: 'leased', note: String(lease.holder?.holder ?? ''),
      });
      return;
    }
    // 2026-11-05：区分「时间过期」与「持锁进程已死」——后者是重启留下的僵尸租约，必须单独点名。
    if (lease.staleFrom) {
      if (lease.deadPid) warn(`[任务中心] ${task.id} 覆盖了死进程残留的租约（pid: ${lease.deadPid}）`);
      else warn(`[任务中心] ${task.id} 覆盖了过期租约（原持有者 ${lease.staleFrom}，疑似进程崩溃残留）`);
    }

    const started = Date.now();
    // ★ 2026-11-05（批次 3）：高频任务（间隔 ≤10 秒）**不写 start 行** —— journal 降噪。
    //   这 4 个任务（trim-agent-tools / tool-security-guard / model-default / heartbeat-bridge）
    //   约 20 次/分钟，每轮写两行（start+ok）占了大头；它们结束时那行已带 `ms` 和 `reason`，
    //   诊断足够。低频任务仍写 start（崩溃时能看出最后在跑哪个慢任务）。
    //   预期：journal 13MB/天 → 6~7MB/天。
    const HIGH_FREQ_TASK_MS = 10_000;
    const isHighFreq = Number(task.everyMs) > 0 && Number(task.everyMs) <= HIGH_FREQ_TASK_MS;
    if (!isHighFreq) {
      journal({ ts: started, taskId: task.id, owner: task.owner, run: task.run, event: 'start', reason: dueInfo.reason });
    }
    /**
     * 执行器返回值语义（三态，2026-11-04 修）：
     *   · `'ok'`   → 真的做了事（记 ok）
     *   · `'skip'` → 正常但无事可做（例如"人格内容没变，无需同步"）→ 记 **skip:no-change**，不算失败
     *   · `'fail'` → 真失败（记 fail + 告警）
     *   兼容旧写法：`true`/`undefined` → ok；`false` → fail（历史 hook 现在返回三态，但保留兼容）。
     * 为什么必须区分：persona-from-file 每 30 秒轮询一次，绝大多数轮次"内容没变"，
     * 若把这种正常情况记成 fail，日志里会每 30 秒刷一条假失败，把真问题淹没。
     */
    let outcome = 'fail';
    let errMsg = '';
    try {
      const ret = await entry.fn(dueInfo.reason);
      if (ret === 'skip') outcome = 'skip';
      else if (ret === 'fail') outcome = 'fail';
      else if (ret === 'ok') outcome = 'ok';
      else if (ret === false) outcome = 'fail';
      else outcome = 'ok'; // true / undefined / 其它真值
    } catch (err) {
      outcome = 'fail';
      errMsg = err instanceof Error ? err.message : String(err);
    } finally {
      releaseLease(paths, task.id);
    }
    const ok = outcome !== 'fail';

    const nowMs = Date.now();
    const ms = nowMs - started;
    // 写前重读（对方宿主可能刚写过别的任务，直接覆盖会把它的记录冲掉）
    const stWrite = refreshLastRun(true);
    /**
     * ★★ 2026-11-05 修（两次才修对）：`atMs` 必须写**判定时刻 `anchorNow`**。
     *
     * 第 1 次修（错）：从"完成时刻"改成"execTask 里的开始时刻" —— 方向对但锚点不对，
     *   因为 execTask 是异步派发的，它的 `Date.now()` 比 tick 的 `now` 晚几毫秒(δ)，
     *   `elapsed = everyMs - δ < everyMs` 仍差那么一点点 → 每个任务稳定多等 1 个 tick。
     *   真机实测铁证：配 3000→实测 4000(+1tick)、配 5000→实测 6000(+1tick)。
     *
     * 第 2 次修（对）：直接用 tick 判定那一刻的 `now`（anchorNow），与执行何时开始无关。
     *   这样 `elapsed` 恰好按 1 秒 tick 对齐，间隔 = everyMs（向上取整到 tick 边界），
     *   不再系统性多 1 个 tick。
     */
    const anchorMs = anchorNow;
    /**
     * ★ 2026-11-05 写 `nextEveryMs`：**这一轮承诺用多久**（仅 interval 有）。
     *
     * 为什么必须写：`jitterMode:'random'` 的任务（R4 心跳）不能每 tick 重新随机，
     * 否则会"永远凑不到期"（详见 lib/central-core.mjs 里 computeDue 的注释）。
     * 做法：**执行完就把下一轮的阈值定下来**并落盘，下一轮直接照它判定。
     * 对 `stable` 模式无影响（它每次现算都得到同一个值）。
     */
    const nextEveryMs = task.kind === 'interval' ? effectiveEveryMs(task) : undefined;
    stWrite.tasks[task.id] = {
      atMs: anchorMs,
      atText: new Date(anchorMs).toISOString(),
      dayKey: zonedParts(nowMs, engine.config.timezone).dayKey,
      done: task.kind === 'once' ? ok || stWrite.tasks[task.id]?.done === true : false,
      ok,
      ...(Number.isFinite(nextEveryMs) ? { nextEveryMs } : {}),
      note: (() => {
        if (outcome === 'fail') return `失败: ${errMsg}`.slice(0, 200);
        if (outcome === 'skip') return `无事可做（不算失败）: ${dueInfo.reason}`.slice(0, 200);
        return dueInfo.reason;
      })(),
    };
    writeLastRun(paths, stWrite);
    lastRunRef.mtime = lastRunMtime(paths);
    if (outcome === 'ok') {
      engine.stats.ran += 1;
      engine.stats.lastRunAt = nowMs;
      journal({ ts: nowMs, taskId: task.id, owner: task.owner, run: task.run, event: 'ok', ms, reason: dueInfo.reason });
      info(`[任务中心] ✓ ${task.id}（${ms}ms，${dueInfo.reason}）`);
    } else if (outcome === 'skip') {
      // 正常但无事可做（例如"人格内容没变，无需同步"）——**不是失败**，只在流水里记一笔。
      engine.stats.skipped += 1;
      journal({
        ts: nowMs, taskId: task.id, owner: task.owner, run: task.run,
        event: 'skip', reason: 'no-change', ms, detail: dueInfo.reason,
      });
    } else {
      engine.stats.failed += 1;
      journal({ ts: nowMs, taskId: task.id, owner: task.owner, run: task.run, event: 'fail', ms, reason: dueInfo.reason, error: errMsg });
      warn(`[任务中心] ✗ ${task.id} 失败（${ms}ms）：${errMsg || '返回 false'}`);
    }
  };

  /** 一轮 tick：读配置（靠 mtime 缓存）→ 逐个判定 → 派发。**永不抛错**。 */
  const tick = () => {
    if (engine.ticking || engine.disposed) return;
    engine.ticking = true;
    try {
      engine.stats.ticks += 1;
      const current = loadConfig(false);
      const now = Date.now();
      let snapshot = refreshLastRun(false);
      for (const task of current.tasks) {
        try {
          if (!task.enabled) continue;
          /**
           * ★★ 2026-11-05 阶段 5 核心改动：**引擎统一驱动 ext 与 plugin 两类任务**。
           *
           * 原来这里是 `if (task.owner !== 'ext') continue;`（"插件侧由它自己的调度器驱动"）。
           * 主人要求「把定时器全部集成在一起」，所以现在**两类都由本引擎驱动**：
           *   · `ext`    —— 执行器由各 hook 的 registerWithFallback 登记（本进程内）；
           *   · `plugin` —— 执行器由插件（dsh-anti-ai-persona）经宿主直接写进
           *                 `globalThis[Symbol.for(REG_KEY)]` 同一个 Map（同进程，无需文件桥）。
           * 注册表本来就按 `run` 键查找，**与 owner 无关**，所以驱动逻辑完全一致；
           * 保留 `owner` 字段的价值在于：诊断/统计时能分清"这条属于谁"。
           *
           * 安全网：若某条 plugin 任务始终没有执行器（插件没装/加载失败），
           * 会记 `skip:unknown-run` 并在启动自检里被点名 —— 不会静默失效。
           */
          if (inflight.has(task.id)) continue; // 同任务并发防重
          // ★ 惰性播种：运行期新加进 tasks.json 的 interval 任务，若没有历史基准，
          //   在这里补一个"从现在起算"的基准 —— 否则它会永远被判"未播种"而永不触发。
          //   一次 tick 最多播种一次（播种后立刻写盘 + 更新 mtime，下一轮就能正常判到期）。
          if (task.kind === 'interval' && !(Number(snapshot.tasks[task.id]?.atMs) > 0)) {
            // 播种基准 = **判定时刻 now**（不另取 Date.now()，保持与锚点口径一致）
            snapshot.tasks[task.id] = {
              atMs: now, atText: new Date(now).toISOString(),
              dayKey: zonedParts(now, current.timezone).dayKey,
              done: false, ok: true, note: '运行期惰性播种基准',
            };
            writeLastRun(paths, snapshot);
            lastRunRef.mtime = lastRunMtime(paths);
            info(`[任务中心] 新增任务 ${task.id} 已惰性播种基准（下一轮到间隔才触发）`);
            continue;
          }
          const dueInfo = computeDue(task, {
            now, last: snapshot.tasks[task.id], timeZone: current.timezone,
            catchUpOnStart: current.catchUpOnStart,
          });
          if (!dueInfo.due) continue;
          if (engine.mode === 'shadow') {
            const tokenKey = `${task.id}:${dueInfo.token}`;
            if (shadowTokens.has(tokenKey)) continue;
            shadowTokens.add(tokenKey);
            if (shadowTokens.size > 500) shadowTokens.clear();
          }
          inflight.add(task.id);
          void Promise.resolve()
            // ★ 把 tick 的 `now` 作为锚点传进去：锚点必须等于**判定时刻**，
            //   不能用 execTask 内部的 Date.now()（异步派发，比 now 晚几毫秒 → 每周期多等 1 tick）。
            .then(() => execTask(task, dueInfo, now))
            .catch((err) => warn(`[任务中心] ${task.id} 派发异常（已忽略）：${err instanceof Error ? err.message : String(err)}`))
            .finally(() => { inflight.delete(task.id); });
        } catch (err) {
          warn(`[任务中心] 判定 ${task?.id ?? '?'} 异常（已跳过）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // 流水保留清理：搭 tick 的便车，不额外开定时器
      if (now - engine.lastJournalRotateMs > JOURNAL_ROTATE_MS) {
        engine.lastJournalRotateMs = now;
        const removed = pruneJournal(paths, current.journalKeepDays, now);
        if (removed > 0) info(`[任务中心] 清理过期流水 ${removed} 个（保留 ${current.journalKeepDays} 天）`);
      }
    } catch (err) {
      warn(`[任务中心] tick 异常（已忽略，下轮继续）：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      engine.ticking = false;
    }
  };

  // ── 启动自检日志（把"配了但没执行器 / 有执行器但没配"当场点出来）─────────
  //   ⚠️ 2026-11-04 实测教训：hooks 按**文件名字典序**逐个加载，
  //   `zz-central-scheduler.mjs` 排第 10、`zz-version-guard.mjs` 排第 13 ——
  //   本引擎 run() 时，排在它后面的 hook 还没登记，自检会误报"尚无执行器"
  //   （实测重启日志里就出现了这条假告警，而流水显示 version-guard 其实每 60s 正常跑）。
  //   所以自检必须**延迟到所有 hook 加载完成之后**再打，否则每次重启都有假噪音。
  const SELF_CHECK_DELAY_MS = 15_000;
  const selfCheck = () => {
    try {
      if (engine.disposed) return;
      const current = engine.config;
      if (!current) return;
      const extTasks = current.tasks.filter((t) => t.owner === 'ext');
      const pluginTasks = current.tasks.filter((t) => t.owner === 'plugin');
      info(`[任务中心] 引擎启动：模式=${current.mode} 粒度=${engine.tickMs}ms 目录=${dir} 任务=${current.tasks.length}（ext ${extTasks.length} / plugin ${pluginTasks.length}）`);
      // ★ 2026-11-05 阶段 5：两类任务都由本引擎驱动 → 自检也必须**两类都查**。
      //   （原来只查 ext，plugin 任务没有执行器时会静默 skip，看不到问题。）
      const missing = current.tasks.filter((t) => t.enabled !== false && !engine.registry.has(t.run));
      if (missing.length > 0) {
        warn(`[任务中心] 以下任务尚无执行器（会记 skip:unknown-run）：${missing.map((t) => `${t.id}→${t.run}(${t.owner})`).join(', ')}`);
      }
      const unlisted = [...engine.registry.keys()].filter((k) => !current.tasks.some((t) => t.run === k));
      if (unlisted.length > 0) {
        info(`[任务中心] 以下执行器已注册但 tasks.json 未列（不会执行，确认是否漏配）：${unlisted.join(', ')}`);
      }
      if (current.mode === 'shadow') {
        info('[任务中心] 当前为影子模式：只判定+记账，不执行任何任务（确认判定准确后把 tasks.json 的 mode 改 live 即生效）');
      }
    } catch { /* 自检失败绝不影响调度 */ }
  };
  const selfCheckTimer = setTimeout(selfCheck, SELF_CHECK_DELAY_MS);
  selfCheckTimer.unref?.();

  // 启动初期先给一行"即将自检"的提示，避免 15 秒内看起来没日志
  info(`[任务中心] 引擎已挂载（tick=${engine.tickMs}ms，任务 ${cfg.tasks.length} 条），${SELF_CHECK_DELAY_MS / 1000}s 后完成执行器对齐自检`);

  // ── 启动标记流水（engine-start）────────────────────────────────────────
  //   ⚠️ 2026-11-04 加：没有这条标记，体检脚本就分不清"这次进程的失败"与
  //   "上一个进程遗留的历史失败" —— 实测旧进程的 19 条 fail 会让新进程的体检持续报错。
  //   有了它，`scripts/taskcenter-health.mjs` 可以只看「最后一次 engine-start 之后」的流水。
  try {
    journal({
      ts: Date.now(), event: 'engine-start',
      note: `模式=${cfg.mode} tick=${engine.tickMs}ms 任务=${cfg.tasks.length} pid=${process.pid}`,
    });
  } catch { /* ignore */ }

  // ── 唯一循环 ─────────────────────────────────────────────────────────
  engine.timer = setInterval(tick, engine.tickMs);
  engine.timer.unref?.();

  // ── 清理（幂等、双通道）──────────────────────────────────────────────
  const dispose = () => {
    if (engine.disposed) return;
    engine.disposed = true;
    engine.alive = false;
    try { if (engine.timer) clearInterval(engine.timer); } catch { /* ignore */ }
    engine.timer = undefined;
    try { clearTimeout(selfCheckTimer); } catch { /* ignore */ }
    try {
      journal({ ts: Date.now(), event: 'engine-stop', note: `运行 ${Math.round((Date.now() - engine.startedAt) / 1000)}s，tick ${engine.stats.ticks} 次` });
    } catch { /* ignore */ }
    if (globalThis[engineKey] === engine) {
      try { delete globalThis[engineKey]; } catch { globalThis[engineKey] = undefined; }
    }
    info('[任务中心] 引擎已停止（定时器已清理）');
  };
  engine.dispose = dispose;
  engine.reloadConfig = () => { engine.configMtime = -1; loadConfig(true); };
  try { env?.registerDispose?.(dispose); } catch { /* ignore */ }

  return `ok(mode=${cfg.mode}, tasks=${cfg.tasks.length}, tick=${engine.tickMs}ms)`;
}

/** 导出 dispose（QQBot 契约会与本 hook 的 registerDispose 一起调用；幂等）。 */
export function dispose() {
  try {
    const engine = globalThis[Symbol.for(ENGINE_SYMBOL_KEY)];
    if (engine && typeof engine.dispose === 'function') engine.dispose();
  } catch { /* ignore */ }
}

export default { name, run, dispose };
