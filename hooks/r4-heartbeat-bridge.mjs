/**
 * r4-heartbeat-bridge — R4 心跳的投递桥：wake-first，失败即沉默
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它是什么
 *   R4（独立插件 `dsh-anti-ai-persona`）把一条心跳写进 outbox 文件，本扩展每 5 秒扫一次，
 *   用**扩展自带的 caps** 把它真正送到该群、或注入给该群的 agent。
 *
 * 背景（2026-11-04）：
 *   R4 拿不到 QQBot 的 sender 实例。QQBot 的出站总线
 *   `globalThis[Symbol.for('im-qqbot.outbound')]` 的 `send()` 要求 `sender` 与 `target`
 *   同时存在（源码：`if (!sender || !target) return false`），而 `sender` 只能从 `lastCtx`
 *   （最近一次出站记录）里取 —— **重启后群里没说过话时 lastCtx = null，心跳必然发不出去**。
 *   所以改走文件桥：R4 原子写文件，扩展包侧消费（方案 A）。
 *
 * ★ 2026-11-05「心跳人性化改造」第二阶段：从「替她说一句」变成「唤醒她，让她自己说」
 *
 *   新 payload（R4 写）：
 *     { id, groupId, text, wakePrompt?, at }
 *     · text       永远写。老桥 `readOutbox` 里 `if (!text) return null` 会整条丢弃，
 *                  所以新 R4 即使只走 wake 模式也必须带 text（向后兼容用）。
 *     · wakePrompt 存在 = 新 wake 模式：注入 agent 会话，由 agent 带完整 system prompt
 *                  跑一个回合，自己看群、自己决定说不说（`reply_gate(false)` 即沉默）。
 *     · wakePrompt 缺省 = 老格式：直接把 text 发到群里。
 *     · at         payload 生成时间（ms）；**过期的丢弃**，见下。
 *
 *   wake-first 语义（本桥核心）：
 *     · 有 wakePrompt  → **只**走 `caps.wakeTo('group', gid, wakePrompt)`：
 *         - 成功 → 写 receipt `status:'injected'`，删 outbox 文件；
 *         - 失败 → 写 receipt `status:'wake-failed'`，**什么都不发**，删 outbox 文件。
 *     · 无 wakePrompt  → 保持老路径：`caps.api` 直发 text，失败再兜底 `caps.wakeTo`
 *         （即 `deliver()`，11-04 踩坑后验证过的可靠通道，原样复用）。
 *
 *   为什么 wake 失败必须「沉默」而不是回落发 text（产品决定，不是 bug）：
 *     `caps.wakeTo` 最终落到 `manager.injectToPeer(scope, peerId, text, 'user')`，第一行
 *     `const record = this.sessions.get(key); if (!record) return false;` —— 会话被回收
 *     （群安静 >30 分钟）时必失败，这是平台约束（上游不可改）。而冷场时硬塞一句模板文案
 *     正是主人 2026-11-04 投诉的那个问题，所以失败就安静（只在 receipt 里留证据）。
 *
 *   为什么老格式仍然用 caps.api 而不是只靠 wakeTo（**2026-11-04 踩过的坑，别删**）：
 *     初版老格式用 `caps.wakeTo('group', gid, text)` 直发，但 wakeTo 的兜底是
 *     `session-registry.findManagerByPeer()`，需要**活跃 manager**；群里没人说话时根本没有
 *     manager → 恒 false → 心跳永远发不出去（「要发消息得先有会话、要会话得先有人说话」的
 *     死循环）。可靠通道是 `caps.api()`（官方 v2 消息接口直连，自动带 token）：
 *       POST /v2/groups/{gid}/messages  body = { msg_type: 0, content: 文本 }
 *     不查 manager、不依赖 lastCtx。所以老格式优先级：① caps.api（可靠）→ ② caps.wakeTo（兜底）。
 *
 *   判重：按 payload `id`（不是内容指纹）。
 *     旧实现把「文件名+内容」指纹存 60 秒，命中时 `continue` **保留文件** —— 60 秒后同一个
 *     文件会被**再投递一次**（outbox 竞态坑）。现在命中已知 id 一律**立即删文件**；
 *     `handled` 条目保留 10 分钟。没有 id 的老 payload 才退回 `文件名::groupId::text` 兜底。
 *
 *   年龄检查：`now - at > 10 分钟` → 删除 + 丢弃，不投递。
 *     防止重启后把几小时前的 wakePrompt 补注入（指令里写着「现在 20:05」）。
 *
 *   桥存活：每轮结束写 `state/heartbeat-outbox/.bridge-alive`
 *     （`{ at, scanned, sent, failed }`）。wake 路径下 outbox 是唯一通道，桥没加载 =
 *     全部心跳静默丢失，R4 那边却还照样记成功 —— 所以要有存活证据。
 *
 * 纪律：
 *   · 只读 R4 的 outbox 目录，**不碰 R4 其它状态**（receipt 是本桥自己的观察文件）；
 *   · 任何异常都吞掉，绝不阻塞 QQBot 主链；
 *   · 发完即删（幂等）；老格式内容为空/dir 非法直接丢弃并记日志；
 *   · 写盘一律先写临时文件再 rename（原子），避免 R4 读到半截 JSON。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { registerWithFallback } from './zz-central-scheduler.mjs';

export const name = 'r4-heartbeat-bridge';

/** PERSONA_DATA_ROOT 的默认位置（与 R4 的 paths.ts 保持一致）。 */
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '{DSH_HOME}/files/home', '.dsh');
const PERSONA_ROOT = process.env.PERSONA_DATA_ROOT
  || join(DSH_HOME, 'data', 'dsh-anti-ai-persona');

/** outbox 目录（R4 写入，本扩展消费）。 */
const OUTBOX_DIR = join(PERSONA_ROOT, 'state', 'heartbeat-outbox');

/** 桥存活心跳文件：每轮 flushOutbox 结束写一次（R4 据此判断桥是否在跑）。 */
const ALIVE_FILE = join(OUTBOX_DIR, '.bridge-alive');

/** wake 注入回执目录：每群一份，覆盖写（只保留最近一次投递的结果）。 */
const RECEIPT_DIR = join(PERSONA_ROOT, 'state', 'heartbeat-receipts');

/** 扫描间隔（毫秒）。5 秒足够实时，又不至于频繁 IO。 */
const SCAN_MS = 5000;

/** 老格式正文上限（防止误发超长内容；wakePrompt 是给 agent 的指令，不截断）。 */
const MAX_LEN = 500;

/** 心跳最大年龄：超过 10 分钟的 outbox 文件不投递（重启补发时防止注入过期指令）。 */
const MAX_AGE_MS = 10 * 60 * 1000;

/** 已处理过的 payload id（key → 处理时间）；按 id 判重，10 分钟内不重复投递。 */
const handled = new Map();
const HANDLED_TTL_MS = 10 * 60 * 1000;

function log(...args) {
  try { console.log('[r4-bridge]', ...args); } catch { /* ignore */ }
}

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标。
 * 失败只记日志、返回 false —— 桥的写盘失败绝不能影响投递主流程。
 */
function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    log('写盘失败:', file, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * 写 wake 回执（覆盖式，每群只留最近一次）。
 * 契约格式：`{ at, via: 'wakeTo', status, id }`，status ∈ injected | wake-failed。
 */
function writeReceipt(groupId, status, id) {
  // 只挡路径分隔符，其余字符原样保留 —— R4 侧按 `{groupId}.json` 读回执才能对上。
  const safe = String(groupId).replace(/[/\\]/g, '_') || 'unknown';
  const payload = { at: Date.now(), via: 'wakeTo', status, id: String(id ?? '') };
  writeFileAtomic(join(RECEIPT_DIR, `${safe}.json`), `${JSON.stringify(payload)}\n`);
}

/** 写桥存活心跳（每轮结束一次；失败静默）。 */
function writeAlive(scanned, sent, failed) {
  writeFileAtomic(ALIVE_FILE, JSON.stringify({ at: Date.now(), scanned, sent, failed }));
}

/**
 * 读取单个出站文件；损坏/非法返回 null。
 *
 * 兼容两种 payload：
 *   · 新：`{ id, groupId, text, wakePrompt?, at }`
 *   · 老：`{ groupId, text, at, decorated? }`（无 id / 无 wakePrompt）
 * 老桥 `readOutbox` 里 `if (!text) return null` 会整条丢弃，所以新 R4 也永远写 text；
 * 这里额外容忍「有 wakePrompt 而 text 为空」，避免上游少写一个字段就丢掉整条心跳。
 *
 * @returns {null | { id: string, groupId: string, text: string, wakePrompt: string, at: number|null }}
 */
function readOutbox(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const groupId = String(obj.groupId ?? '').trim();
    if (!groupId) return null;
    const text = String(obj.text ?? '').trim();
    const wakePrompt = String(obj.wakePrompt ?? '').trim();
    if (!text && !wakePrompt) return null; // 没有任何可投递内容
    const at = Number(obj.at);
    return {
      id: String(obj.id ?? '').trim(),
      groupId,
      text: text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text,
      wakePrompt,
      at: Number.isFinite(at) && at > 0 ? at : null, // 老 payload 缺 at 时不做年龄判定
    };
  } catch {
    return null;
  }
}

/** 删除文件（失败不抛）。 */
function removeFile(file) {
  try { if (existsSync(file)) unlinkSync(file); } catch { /* ignore */ }
}

/**
 * 真正把一条老格式文本发到群 —— **不依赖任何活跃会话**。
 *
 * ★ 2026-11-04 核心修正：初版用 `caps.wakeTo('group', gid, text)`，
 *   但 wakeTo 的兜底是 `session-registry.findManagerByPeer()`，需要**活跃会话/manager**。
 *   群里没人说话时根本没有 manager → 恒 false → 心跳永远发不出去
 *   （即「要发消息得先有会话、要会话得先有人说话」的死循环）。
 *
 *   正确通道是 `caps.api()`（官方 v2 消息接口直连，自动带 token）：
 *     POST /v2/groups/{gid}/messages  body = { msg_type: 0, content: 文本 }
 *   与 commands/子会话.mjs 发卡片同一套 caps.api，不查 manager、不需要 msg_id。
 *
 * 优先级：① caps.api（可靠） → ② caps.wakeTo（需活跃会话，仅兜底）
 * @returns { ok: boolean, via: string }
 */
async function deliver(caps, groupId, text) {
  const api = caps?.api;
  if (typeof api === 'function') {
    try {
      const r = await api(`/v2/groups/${encodeURIComponent(groupId)}/messages`, {
        method: 'POST',
        body: { msg_type: 0, content: String(text) }, // 0 = 纯文本
      });
      // ⚠️ caps.api 的 `ok` 只代表 **HTTP 成功**，不代表消息真发出去了。
      //    必须再看 `data`：成功通常返回带 id/msg_id 的消息对象；
      //    失败常见 `{ code, message }`（主动推送配额耗尽、频率限制等）。
      const httpOk = Boolean(r && r.ok !== false);
      const data = r?.data;
      const rejected = (() => {
        if (data === undefined || data === null) return false;
        if (typeof data !== 'object') return false;
        const code = Number(data.code);
        if (Number.isFinite(code) && code !== 0) return true;
        const hasId = Boolean(data.id ?? data.message_id ?? data.msg_id ?? data.msgId);
        return !hasId && data.error !== undefined;
      })();
      if (httpOk && !rejected) return { ok: true, via: 'api' };
      log(`caps.api 未成功：httpOk=${httpOk} data=${JSON.stringify(data ?? r?.err ?? null).slice(0, 160)}`);
    } catch (error) {
      log('caps.api 抛错：', error instanceof Error ? error.message : String(error));
    }
  }

  const wakeTo = caps?.wakeTo;
  if (typeof wakeTo === 'function') {
    try {
      const r = await wakeTo('group', groupId, text);
      if (r !== false) return { ok: true, via: 'wakeTo' };
      log('wakeTo 返回 false（无活跃会话，属预期）');
    } catch (error) {
      log('wakeTo 抛错：', error instanceof Error ? error.message : String(error));
    }
  }

  return { ok: false, via: '' };
}

/**
 * 扫一轮 outbox。
 * @param caps 扩展 caps（含 api / wakeTo）
 * @returns { scanned, sent, failed }
 *
 * 侧效：每轮结束（含异常/提前返回）写一次 `.bridge-alive`。
 */
export async function flushOutbox(caps) {
  let scanned = 0;
  let sent = 0;
  let failed = 0;

  let names = null;
  try {
    // `.bridge-alive` 以 `.json` 过滤时天然不会被读到；下面再显式跳过一道，
    // 把这条约定写死，防止以后有人放宽过滤条件把它当心跳投递。
    names = readdirSync(OUTBOX_DIR).filter((f) => f.endsWith('.json') && f !== '.bridge-alive');
  } catch {
    names = null; // 目录不存在 = 常态（R4 还没写过任何心跳）
  }

  if (names === null) {
    writeAlive(0, 0, 0);
    return { scanned: 0, sent: 0, failed: 0 };
  }

  const hasApi = typeof caps?.api === 'function';
  const wakeToFn = caps?.wakeTo ?? caps?.wake;
  const wakeTo = typeof wakeToFn === 'function' ? wakeToFn : null;

  try {
    if (!hasApi && !wakeTo) {
      // caps 不可用（扩展环境异常）→ **保留文件**，下轮再试（不要白删）
      log('caps.api / caps.wakeTo 均不可用，本轮跳过（文件保留）');
      return { scanned, sent, failed };
    }

    // 清理过期的 handled 记录
    const now = Date.now();
    for (const [k, at] of handled) {
      if (now - at > HANDLED_TTL_MS) handled.delete(k);
    }

    for (const outboxName of names) {
      scanned += 1;
      const file = join(OUTBOX_DIR, outboxName);

      const item = readOutbox(file);
      if (!item) {
        log('丢弃非法出站文件:', outboxName);
        removeFile(file);
        continue;
      }

      // ① 年龄检查：重启后补发不能把几小时前的指令（里面写着「现在 20:05」）注进去
      const age = item.at === null ? null : Date.now() - item.at;
      if (age !== null && age > MAX_AGE_MS) {
        log('丢弃过期心跳:', outboxName);
        removeFile(file);
        continue;
      }

      // ② 判重按 id：命中已知 id **必须立即删文件**（旧实现 continue 保留 → 60 秒后重发）
      const key = item.id || `${outboxName}::${item.groupId}::${item.text || item.wakePrompt}`;
      if (handled.has(key)) {
        removeFile(file);
        log('跳过重复心跳（id 已处理）:', outboxName);
        continue;
      }

      // ③ wake 模式：只注入唤醒指令；失败即沉默（产品决定，**绝不回落发 text**）
      if (item.wakePrompt) {
        let ok = false;
        if (!wakeTo) {
          log('caps.wakeTo 不可用（扩展环境异常），按 wake 失败处理并沉默');
        } else {
          try {
            const r = await wakeTo.call(caps, 'group', item.groupId, item.wakePrompt);
            ok = r !== false;
            if (!ok) log('wakeTo 返回 false（会话可能已被回收，按产品决定沉默）');
          } catch (error) {
            log('wakeTo 抛错：', error instanceof Error ? error.message : String(error));
          }
        }
        handled.set(key, Date.now());
        if (ok) {
          writeReceipt(item.groupId, 'injected', item.id);
          removeFile(file);
          sent += 1;
          log(`已注入心跳 wake（群 ${item.groupId.slice(0, 8)}…，id=${item.id || '-'}）`);
        } else {
          // 失败也删：不做重试。重试 = 过一会儿又注入一条过期指令，比丢更糟。
          writeReceipt(item.groupId, 'wake-failed', item.id);
          removeFile(file);
          failed += 1;
          log(`wake 注入失败（群 ${item.groupId.slice(0, 8)}…）：保持沉默，不调 caps.api`);
        }
        continue;
      }

      // ④ 老格式：保持原行为 —— caps.api 直发 text，失败再兜底 wakeTo
      try {
        const r = await deliver(caps, item.groupId, item.text);
        handled.set(key, Date.now());
        if (r.ok) {
          removeFile(file);
          sent += 1;
          log(`已投递心跳到群 ${item.groupId.slice(0, 8)}…（via=${r.via}，${item.text.length} 字）`);
        } else {
          removeFile(file); // 两条通道都失败也删，避免无限堆积（R4 侧有状态日志）
          failed += 1;
          log(`投递失败（群 ${item.groupId.slice(0, 8)}…，api+wakeTo 均不可用）`);
        }
      } catch (error) {
        failed += 1;
        handled.set(key, Date.now());
        removeFile(file);
        log('投递抛错:', error instanceof Error ? error.message : String(error));
      }
    }

    return { scanned, sent, failed };
  } finally {
    // ⑤ 桥存活心跳：每轮结束都写（异常/提前 return 也写），R4 据此判断桥是否在跑
    writeAlive(scanned, sent, failed);
  }
}

/**
 * hook 入口：启动时扫一次，之后按节律扫描（默认 5 秒）。
 * @param env 扩展环境（env.caps 提供 wakeTo / registerDispose）
 *
 * ★ 2026-11-05 阶段 2 收编：节律交给中央调度器（tasks.json 的 `ext-heartbeat-bridge`，
 *   **everyMs 必须保持 5000，禁止降频**）。
 *
 * 为什么这个桥和别的 hook 不一样（改之前务必读懂）：
 *   · 它**没有任何事件驱动兜底** —— 全靠轮询 `heartbeat-outbox/` 目录发现新文件。
 *     R4 把心跳写进文件，桥这边扫到才投递。**拉长间隔 = 直接增加心跳送达延迟**，
 *     所以 tasks.json 里这一项写死 5000，不要"顺手优化"成 30s/60s。
 *   · `await tick()` 是**启动即执行** —— 重启后磁盘上若还压着未投递的心跳，
 *     这次首跑会立刻补发（超过 10 分钟的由年龄检查丢弃）。**收编时必须保留它**，
 *     否则第一封心跳会晚一个周期。
 */
export async function run(env) {
  const caps = env?.caps ?? env;
  const hasApi = typeof caps?.api === 'function';
  const hasWake = typeof (caps?.wakeTo ?? caps?.wake) === 'function';
  if (!caps || (!hasApi && !hasWake)) {
    log('未拿到 caps.api / caps.wakeTo，桥接不启动');
    return;
  }
  log(`caps 能力：api=${hasApi} wakeTo=${hasWake}${hasWake ? '（新格式 wake 走 wakeTo；老格式 caps.api 直发优先）' : '（无 wakeTo：wake 模式会失败并沉默；老格式仍走 caps.api）'}`);

  const tick = async () => {
    try { await flushOutbox(caps); } catch { /* 绝不阻塞主链 */ }
  };

  // ① 启动即扫一次：把重启前压在磁盘上的心跳立刻补发（**不可删**，见上方注释）
  await tick();

  // ② 节律交给中央调度器；引擎缺席时才用自带定时器。
  registerWithFallback('heartbeat-bridge', () => tick(), {
    env, fallbackMs: SCAN_MS, label: 'heartbeat-bridge', meta: { id: 'ext-heartbeat-bridge' },
  });
  log(`已启动：按 任务中心/tasks.json 的节律扫描 ${OUTBOX_DIR}（基准 ${SCAN_MS / 1000} 秒，禁止降频）`);
}

export function dispose() {
  // 2016-11-05 阶段 2 收编后本 hook 不再自己持有定时器：
  //   · 正常由 `registerWithFallback` 把自己的降级定时器登记进 registerDispose；
  //   · 引擎侧由 `zz-central-scheduler` 的 dispose 统一清理。
  // 这里保留 `dispose` 导出（QQBot 契约要求），但**不再清 timer**（已无 timer 可清）。
}

export default { name, run, dispose };
