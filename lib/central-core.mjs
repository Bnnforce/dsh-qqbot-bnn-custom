/**
 * central-core — 任务中心「纯逻辑层」：配置校验 / 到期判定 / 抖动派生。
 *
 * 设计约束（为什么单独抽这一层）：
 *   · **零 IO、零定时器、零全局状态** —— 可以被单测直接喂假时间，不依赖真实时钟；
 *   · 引擎（central-engine.mjs）只负责"读文件、跑循环、记账"，所有"该不该跑"的判断都在这里；
 *   · 这样将来加任务类型只改本文件，不会碰引擎的循环逻辑。
 *
 * 数据来源：`{WORKSPACE_ROOT}/Bot/任务中心/tasks.json`（可被 DSH_TASK_CENTER 覆盖）
 */
import { join } from 'node:path';
import { DATA_ROOT } from './pack-paths.mjs';

/** 任务归属：ext=QQBot 扩展侧宿主；plugin=DSH 插件侧宿主（本引擎只驱动自己的 owner）。 */
export const VALID_OWNERS = ['ext', 'plugin'];
/** 支持的调度类型。 */
export const VALID_KINDS = ['interval', 'daily', 'once'];
/** 引擎实例在 globalThis 上的符号键（防止热重载/网关重建时叠加第二个引擎）。 */
export const ENGINE_SYMBOL_KEY = 'dsh.taskcenter.engine.v1';
/** 执行器注册表在 globalThis 上的符号键。 */
export const REGISTRY_SYMBOL_KEY = 'dsh.taskcenter.registry.v1';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/**
 * 任务中心根目录：`DSH_TASK_CENTER` 环境变量优先（测试隔离/多实例必需），
 * 否则由数据根上跳一级推导（`.../Bot/dshqqbot` → `.../Bot/任务中心`），与 persona-store 同款写法。
 */
export function taskCenterDir() {
  const override = String(process.env.DSH_TASK_CENTER ?? '').trim();
  if (override) return override;
  return join(DATA_ROOT, '..', '任务中心');
}

/** 任务 id 会被拼进文件名（lease），必须清洗：只留字母数字点横线下划线。 */
export function sanitizeTaskId(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return s || 'unnamed';
}

/** `HH:MM` → `{hour, minute, minutes}`；非法返回 null（绝不抛错）。 */
export function parseHhMm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute, minutes: hour * 3600 + minute * 60 };
}

/**
 * 指定时区下的时间分量。非法时区 → 回退默认时区（与 R4 侧 `resolveTimeZone` 同一口径）。
 * 永不抛错。
 */
export function zonedParts(ms, timeZone = DEFAULT_TIMEZONE) {
  const at = Number.isFinite(Number(ms)) ? Number(ms) : Date.now();
  const tryFormat = (tz) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  let parts;
  try {
    parts = tryFormat(timeZone);
  } catch {
    try { parts = tryFormat(DEFAULT_TIMEZONE); } catch { parts = null; }
  }
  if (!parts) {
    // 极端兜底：Intl 完全不可用时退化为本机时间
    const d = new Date(at);
    parts = {
      year: String(d.getFullYear()),
      month: String(d.getMonth() + 1).padStart(2, '0'),
      day: String(d.getDate()).padStart(2, '0'),
      hour: String(d.getHours()).padStart(2, '0'),
      minute: String(d.getMinutes()).padStart(2, '0'),
      second: String(d.getSeconds()).padStart(2, '0'),
    };
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    dayKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** 稳定哈希（同一个 id 永远得到同一个抖动，重启不跳变）。 */
export function hash32(text) {
  let h = 2166136261;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 抖动：`jitterMs` 对称区间内的偏移。
 *
 * 两种模式（2026-11-05 新增 `random`，为收编 R4 心跳而加）：
 *
 *   · `'stable'`（缺省，也是原行为）—— **由 id 哈希派生**，同一个任务永远得到同一个偏移。
 *     为什么默认这样：若「每次 tick 重新随机」，长周期任务可能**永远凑不到期**
 *     （每轮随机都把它推远），表现为"任务不跑"。
 *
 *   · `'random'` —— **每次到期重算**，用于「必须是真随机」的场景。
 *     R4 心跳就是这种：它要的是 `45±15 分钟`**每次不同**，
 *     否则她每天在同样几个时刻开口，一眼就是机器人（拟人化直接失效）。
 *     安全性靠 `computeDue` 的判据保证：`elapsed >= effectiveEveryMs` 才算到期，
 *     而 `effectiveEveryMs` 只在**判定那一刻**取一次值，所以不会出现"永远凑不到期"。
 */
export function jitterForTask(task) {
  const jitter = Math.max(0, Math.floor(Number(task?.jitterMs) || 0));
  if (jitter === 0) return 0;
  if (String(task?.jitterMode ?? 'stable') === 'random') {
    // 对称区间 [−jitter, +jitter]，含两端
    return Math.floor((Math.random() * 2 - 1) * jitter);
  }
  const span = jitter * 2 + 1;
  return (hash32(task?.id) % span) - jitter;
}

/** 实际生效的周期（含抖动，最小时长 1 秒）。 */
export function effectiveEveryMs(task) {
  const base = Math.max(1000, Math.floor(Number(task?.everyMs) || 0));
  return Math.max(1000, base + jitterForTask(task));
}

/** 单条任务清洗。返回 `{task}` 或 `{error}`（错误文案会进 validateConfig 的 errors）。 */
export function normalizeTask(raw, index = 0) {
  const at = `tasks[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${at} 不是对象` };
  const id = String(raw.id ?? '').trim();
  if (!id) return { error: `${at} 缺少 id` };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) return { error: `${at} id 非法（只允许字母数字 . _ -，且不以符号开头）：${id}` };
  const owner = String(raw.owner ?? 'ext').trim();
  if (!VALID_OWNERS.includes(owner)) return { error: `${at} owner 非法：${owner}` };
  const kind = String(raw.kind ?? '').trim();
  if (!VALID_KINDS.includes(kind)) return { error: `${at} kind 非法：${kind || '(空)'}` };
  const run = String(raw.run ?? '').trim();
  if (!run) return { error: `${at} 缺少 run（执行器键名）` };

  const task = {
    id,
    owner,
    kind,
    run,
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    jitterMs: Math.max(0, Math.floor(Number(raw.jitterMs) || 0)),
    // 抖动模式：stable（缺省，id 哈希派生，重启不跳变）/ random（每次到期重算）
    jitterMode: 'stable',
    note: String(raw.note ?? '').slice(0, 200),
  };
  if (String(raw.jitterMode ?? '').trim() === 'random') task.jitterMode = 'random';
  if (kind === 'interval') {
    const everyMs = Math.floor(Number(raw.everyMs) || 0);
    if (everyMs < 1000) return { error: `${at} everyMs 必须 ≥ 1000（收到 ${raw.everyMs}）` };
    if (task.jitterMs >= everyMs) return { error: `${at} jitterMs 必须小于 everyMs` };
    task.everyMs = everyMs;
  } else if (kind === 'daily') {
    const hhmm = parseHhMm(raw.at);
    if (!hhmm) return { error: `${at} at 非法（需 HH:MM）：${raw.at}` };
    task.at = `${String(hhmm.hour).padStart(2, '0')}:${String(hhmm.minute).padStart(2, '0')}`;
    task.catchUp = raw.catchUp === undefined ? true : raw.catchUp === true;
  } else {
    const dueAt = Number(raw.dueAt);
    if (!Number.isFinite(dueAt) || dueAt <= 0) return { error: `${at} dueAt 非法（需毫秒时间戳）` };
    task.dueAt = dueAt;
  }
  return { task };
}

/**
 * 校验整份配置。**永不抛错**。
 *
 * ★ 2026-11-05 修 P0（一处 tasks.json 手滑 = 12 个任务全停）：
 *   原实现在 errors 非空时**整份**回退 `builtinDefaultConfig()`（3 条 + shadow），
 *   于是一条任务写错就让 trim / 安全守卫 / 心跳桥等 12 条全部停摆，
 *   而日志却写"该任务已跳过，其余照常"——与真实行为相反。
 *
 *   现在的分层语义：
 *     1. **逐条清洗**：合法的任务保留并返回，非法的丢弃 + 记录（`dropped` 可点名）；
 *     2. **全部非法**（数组非空但一条都留不下）→ 回退内置默认安全网，避免引擎空跑；
 *     3. **整份不可解析**（根节点不是对象 / tasks 不是数组）→ 回退内置默认。
 *
 *   回退时 `mode` 必须**继承原配置**（不能静默降级成 shadow）：
 *   原对象里有合法 mode 就照抄；否则继承 `options.fallbackMode`（引擎传上次生效值）；
 *   连它也没有才保持 `'live'` 并 warn。
 *
 * 返回 `{ok, config, warnings, errors, validCount, droppedCount, dropped, fallback}`：
 *   · `ok=false` 只表示"有错误"；`config` 仍可能是**部分可用**的任务表，调用方应照常运行；
 *   · `fallback=true` 表示整份被丢弃、`config` 是内置默认；
 *   · `dropped` 形如 `{index, id, reason}`，供日志点名"到底丢了哪些任务"。
 */
export function validateConfig(raw, options = {}) {
  const warnings = [];
  const errors = [];
  const dropped = [];
  const previousMode = String(options?.fallbackMode ?? '').trim();

  /** 回退内置默认时决定 mode（原配置优先 → 上次生效 → live，绝不静默降级）。 */
  const resolveFallbackMode = (source) => {
    const rawMode = source && typeof source === 'object' && !Array.isArray(source)
      ? String(source.mode ?? '').trim()
      : '';
    if (rawMode === 'live' || rawMode === 'shadow') return rawMode;
    if (previousMode === 'live' || previousMode === 'shadow') {
      warnings.push(`回退内置默认：原配置 mode 不可读 → 继承上次生效的 mode=${previousMode}`);
      return previousMode;
    }
    warnings.push('回退内置默认：原配置 mode 不可读 → 保持 live（不静默降级为 shadow）');
    return 'live';
  };

  /** 整份回退：内置默认任务表 + 继承 mode。 */
  const fallbackConfig = (source) => {
    const config = builtinDefaultConfig();
    config.mode = resolveFallbackMode(source);
    return config;
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('配置根节点不是对象（整份 JSON 无法解析）');
    return {
      ok: false, config: fallbackConfig(null), warnings, errors,
      validCount: 0, droppedCount: 0, dropped, fallback: true,
    };
  }
  const timezone = String(raw.timezone ?? DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  let tzOk = true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { tzOk = false; }
  if (!tzOk) {
    warnings.push(`timezone 非法（${timezone}）→ 回退 ${DEFAULT_TIMEZONE}`);
  }
  const mode = String(raw.mode ?? 'shadow').trim();
  if (!['shadow', 'live'].includes(mode)) {
    warnings.push(`mode 非法（${mode}）→ 回退 shadow（不会真执行）`);
  }
  const tickMsRaw = Math.floor(Number(raw.tickMs) || 0);
  const tickMs = Math.min(60_000, Math.max(500, tickMsRaw || 1000));
  if (tickMsRaw && tickMsRaw !== tickMs) warnings.push(`tickMs 越界（${tickMsRaw}）→ 收敛到 ${tickMs}`);
  const journalKeepDays = Math.max(1, Math.floor(Number(raw.journalKeepDays) || 30));
  const leaseTtlMs = Math.max(1000, Math.floor(Number(raw.leaseTtlMs) || 600_000));

  const list = Array.isArray(raw.tasks) ? raw.tasks : null;
  if (!list) {
    errors.push('tasks 必须是数组');
    return {
      ok: false, config: fallbackConfig(raw), warnings, errors,
      validCount: 0, droppedCount: 0, dropped, fallback: true,
    };
  }

  const tasks = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const normalized = normalizeTask(list[i], i);
    if (normalized.error) {
      errors.push(normalized.error);
      dropped.push({
        index: i,
        id: String(list[i]?.id ?? '').trim() || `tasks[${i}]`,
        reason: normalized.error,
      });
      continue;
    }
    const task = normalized.task;
    if (seen.has(task.id)) {
      warnings.push(`重复任务 id（${task.id}）→ 保留第一条，忽略后面这条`);
      continue;
    }
    seen.add(task.id);
    tasks.push(task);
  }

  // 全部非法 → 安全网：回退内置默认，避免"一条都不跑"（那同样等于全停）。
  if (list.length > 0 && tasks.length === 0) {
    warnings.push(`全部 ${list.length} 条任务都不合法 → 回退内置默认安全网（mode 继承原配置）`);
    return {
      ok: false, config: fallbackConfig(raw), warnings, errors,
      validCount: 0, droppedCount: dropped.length, dropped, fallback: true,
    };
  }

  const config = {
    version: Math.max(1, Math.floor(Number(raw.version) || 1)),
    mode: ['shadow', 'live'].includes(mode) ? mode : 'shadow',
    timezone: tzOk ? timezone : DEFAULT_TIMEZONE,
    tickMs,
    catchUpOnStart: raw.catchUpOnStart === undefined ? true : raw.catchUpOnStart === true,
    journalKeepDays,
    leaseTtlMs,
    tasks,
  };
  return {
    ok: errors.length === 0, config, warnings, errors,
    validCount: tasks.length, droppedCount: dropped.length, dropped, fallback: false,
  };
}

/**
 * 内置默认任务表 —— 与 `任务中心/tasks.json` 的**阶段 1 内容一致**。
 * 用途：配置文件缺失/损坏时保持既有行为（三个低风险巡检继续跑），绝不因为配置问题停摆。
 */
export function builtinDefaultConfig() {
  return {
    version: 1,
    mode: 'shadow',
    timezone: DEFAULT_TIMEZONE,
    tickMs: 1000,
    catchUpOnStart: true,
    journalKeepDays: 30,
    leaseTtlMs: 600_000,
    tasks: [
      { id: 'ext-persona-lint', owner: 'ext', kind: 'interval', run: 'persona-lint', enabled: true, everyMs: 120_000, jitterMs: 0, note: '人格硬规则巡检（原 120s）' },
      { id: 'ext-version-guard', owner: 'ext', kind: 'interval', run: 'version-guard', enabled: true, everyMs: 60_000, jitterMs: 0, note: 'commands/inbound 变更校验（原 60s）' },
      { id: 'ext-persona-from-file', owner: 'ext', kind: 'interval', run: 'persona-from-file', enabled: true, everyMs: 30_000, jitterMs: 0, note: '规则/角色卡目录轮询（原 15s → 30s）' },
    ],
  };
}

/**
 * 到期判定（引擎唯一的"时间裁判"）。
 * ctx：`{now, last, timeZone, catchUpOnStart}`；`last` 形如 `{atMs, dayKey, done}`。
 *
 * 返回 `{due, reason, token}`：
 *   · `due=false` 时 `reason` 是**给人看的中文原因**（直接进日志/健康表）；
 *   · `token` 标识"这一次到期"，用于影子模式去重（同一 token 只记一次 would-run）。
 */
export function computeDue(task, ctx) {
  const now = Number(ctx?.now);
  const last = ctx?.last && typeof ctx.last === 'object' ? ctx.last : null;
  const timeZone = String(ctx?.timeZone || DEFAULT_TIMEZONE);
  const catchUp = ctx?.catchUpOnStart !== false;
  if (!Number.isFinite(now) || !task) return { due: false, reason: '参数非法', token: '' };
  const parts = zonedParts(now, timeZone);

  if (task.kind === 'interval') {
    const lastAt = Number(last?.atMs);
    if (!Number.isFinite(lastAt) || lastAt <= 0) {
      // 没有历史记录：由引擎播种（把 now 记为基准），本轮**不触发** ——
      // 各 hook 的 run(env) 里本来就做过一次"启动即跑"，这里再补一次就是重复执行。
      return { due: false, reason: '未播种（等待首次基准）', token: '' };
    }
    /**
     * ★ 2026-11-05 抖动取值口径（收编 R4 心跳时定的，很重要）：
     *
     *   `stable`（缺省）：每次现算都一样（id 哈希），所以现算安全。
     *
     *   `random`（R4 心跳用）：**必须用「上一轮承诺的目标间隔」，不能每 tick 重新随机**。
     *   否则会出现经典的"随机阈值永远凑不到期"：
     *     每 tick 都重掷 interval ∈ [30,60]min，攒了 40 分钟时掷出 55 分钟 → 判未到
     *     再攒到 50 分钟时掷出 58 分钟 → 又未到 …… 任务表现为"不跑"。
     *
     *   所以：引擎在**每次成功执行后**把"这一轮实际要用多久"写进 last-run 的
     *   `nextEveryMs`，这里直接读它作为阈值。读不到（旧数据/首次）才现算一次。
     */
    const promised = Number(last?.nextEveryMs);
    const everyMs = Number.isFinite(promised) && promised >= 1000
      ? promised
      : effectiveEveryMs(task);
    const elapsed = now - lastAt;
    if (elapsed < everyMs) {
      return { due: false, reason: `未到间隔（还差 ${Math.ceil((everyMs - elapsed) / 1000)}s）`, token: '' };
    }
    return {
      due: true,
      reason: elapsed > everyMs * 2 ? `逾期补跑（已过 ${Math.floor(elapsed / 1000)}s）` : '到间隔',
      token: `i:${lastAt}:${Math.floor(now / everyMs)}`,
    };
  }

  if (task.kind === 'daily') {
    const hhmm = parseHhMm(task.at);
    if (!hhmm) return { due: false, reason: `at 非法（${task.at}）`, token: '' };
    const runDate = String(last?.dayKey ?? '');
    if (runDate === parts.dayKey) return { due: false, reason: '今天已跑过', token: '' };
    const nowSeconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
    if (nowSeconds < hhmm.minutes) return { due: false, reason: `未到点（${task.at}）`, token: '' };
    // 已经过点且今天没跑 → 到期。`catchUp` 只是**给日志换个说法**：
    // 启动补偿的语义就藏在这条判据里（"昨天没跑，今天过了点"必然命中）。
    const stale = Boolean(runDate);
    return {
      due: true,
      reason: catchUp && stale ? `启动补偿（上次 ${runDate}，已过 ${task.at}）` : '到点',
      token: `d:${parts.dayKey}`,
    };
  }

  if (task.kind === 'once') {
    const dueAt = Number(task.dueAt);
    if (!Number.isFinite(dueAt)) return { due: false, reason: 'dueAt 非法', token: '' };
    if (last?.done === true) return { due: false, reason: '已完成（一次性）', token: '' };
    if (now < dueAt) return { due: false, reason: `未到时间（还差 ${Math.ceil((dueAt - now) / 1000)}s）`, token: '' };
    return { due: true, reason: '到时间', token: `o:${dueAt}` };
  }

  return { due: false, reason: `未知 kind（${task.kind}）`, token: '' };
}
