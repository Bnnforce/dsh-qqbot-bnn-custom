/**
 * trim-agent-tools — QQ 会话工具瘦身（按 agent 作用域剪枝继承工具）
 *
 * 背景（2026-10-18 主人要求）：
 *   QQ 机器人原来每次请求带 141 个工具（android 27 / undo 16 / browser 17 / 团队 8 / …
 *   加上预设的 bash/fs/goal/schedule/子代理 等），对 kilo-auto/free 这种免费模型太重。
 *
 * 做法：只对 **QQ 会话**（cwd 在 Bot 工作区）调用宿主提供的
 *   `agent.ctx.tools.restrict({ deny })` —— 这是 per-scope 的可见性剪枝（黑名单模式）：
 *   · 只过滤**继承来的**工具（全局层 + 预设/祖先层）；
 *   · agent 自己注册的通道工具（reply_gate / send_media / 表情包 / 定时…）和
 *     扩展工具（qq_send …）**不受影响**；
 *   · 剪枝挂在 agent 自己的作用域上，agent 销毁自动回收。
 *
 * ★ 2026-11-02 主人新要求「群聊日常只用三类工具」：
 *   日常对话只保留 **记忆搜索 / 视觉识别 / 网页搜索** 三件套
 *   （+ 群聊本身必需的上下文备忘与提问交互）。
 *   会写盘、跑命令、翻文件系统的「重工具」（write / edit / str_replace_editor /
 *   bash / present / todo_write / read / glob / grep）**全部从白名单移除** ⇒
 *   agent 在工具面上根本看不到，也就不可能"顺手写个文件"。
 *   要写文件时由 zz-tool-security-guard 按「当前消息是否明确要求写」再放行（执行层兜底）。
 *
 * 时机：启动钩子跑一次，然后每 3s 扫一遍 agents.list()，给新出现的 QQ agent 补剪枝
 *   （创建/恢复都会走这里；已有 agent 在网关重建后也会被重新创建并剪枝）。
 * 失败关闭：任何异常只 warn，绝不影响消息链路。
 */
import { appendFileSync } from 'node:fs';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { DATA_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';

export const name = 'trim-agent-tools';

/**
 * 只保留这些「继承工具」（其余继承工具一律隐藏）。
 *
 * 历史变更：
 *   2026-10-22 曾恢复 bash/read/write/edit/glob/grep，靠 guard 做 owner 门禁；
 *   2026-11-02 主人反馈「她过于喜欢主动写文件」⇒ 这一批**整体移除**，
 *              日常只留 记忆/识图/联网 三件套。
 *   不要因为"主人可能需要"就把它们加回来 —— 写文件走明确指令 + guard 放行。
 */
/**
 * 明确要裁掉的「继承工具」。
 *
 * ★ 2026-11-18 架构调整：由 ALLOW（白名单）改为 DENY（黑名单）。
 *
 * 为什么改（这条很重要，别再改回白名单）：
 *   白名单的语义是「没写进去的一律不可见」，于是每次新增工具（私聊能力、人格切换、
 *   语音收发、以及未来任何新插件）都必须回来改这个文件，漏一次就表现为
 *   「模型说它没有这个工具」，极难归因。这正是 2026-11-16 group_birthday
 *   踩过的坑（规则文件要求她能查生日，但名字没进白名单 ⇒ 她看不见）。
 *   黑名单反过来：默认全部可用，只有明确有害/越权的名字才挡，新增能力自动生效。
 *
 * 职责划分（重要）：
 *   · 本文件（trim）只做「可见性」——决定模型看不看得到；
 *   · zz-tool-security-guard.mjs 做「执行层」门禁——
 *     ALWAYS_DENY_TOOLS（Agent Teams/子代理/编排，一律拒）、
 *     DEVICE_TOOLS（android_* 设备面，一律拒）、
 *     OWNER_ONLY（踢人/撤回/broadcast/写库等，仅主人）、
 *     HEAVY_WRITE_TOOLS + 写入意图正则（write/edit/bash 需明确指令）。
 *   ⇒ 所以这里**不需要**为了安全而隐藏 shell/写文件：guard 会在执行时拦。
 *     写文件工具必须对模型可见，否则「主人明确要求保存到 xxx.md」时
 *     模型连工具都看不到，guard 也就没有机会按意图放行。
 */
const DENY = [
  // ── 设备面：主人 2026-11-02 已撤回 root 与虚拟屏权限，任何会话都不给 ──
  //   guard 的 DEVICE_TOOLS + android_ 前缀检查是无条件拒绝，这里同步隐藏，
  //   省掉这部分 schema 的 token 开销。
  'android_capabilities', 'android_device_info', 'android_privilege_status',
  'android_screen_list', 'android_screenshot', 'android_vdisplay_status',
  'android_vdisplay_create', 'android_vdisplay_destroy', 'android_vdisplay_input',
  'android_app_launch', 'android_ui_dump', 'android_ui_tree', 'android_ui_detail',
  'android_ui_click', 'android_ui_scroll', 'android_ui_input', 'android_ui_global',
  'android_browser_tier', 'android_web_dump', 'android_shell_exec',
  'android_termux_channel_exec', 'android_env_prepare', 'android_env_recipe',
  'android_toolchain_status', 'android_file_incoming_status', 'android_act_input',
  //
  // ── 内嵌 AI 浏览器：QQ 会话里没有正当用途 ──
  'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_press', 'browser_scroll', 'browser_get_text',
  'browser_screenshot', 'browser_back', 'browser_forward', 'browser_reload',
  'browser_wait', 'browser_close_tab', 'browser_follow_tab', 'browser_list_tabs',
  'browser_set_identity', 'browser_set_viewport',
  //
  // ── Harness 自身维护：群里不该出现 ──
  'plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query',
  'dshmarketplace_search', 'dshmarketplace_install', 'tools_reload',
  //
  // ── 委派与编排：guard 里在 ALWAYS_DENY_TOOLS，一律拒 ──
  'subagent', 'subagent_fork', 'workflow', 'ralph',
  'list_agents', 'send_message', 'interrupt_agent', 'list_subagent_models',
  'spawn_teammate', 'wait_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //
  // ── 跨会话检索：QQ 会话里会把别的会话内容带进来，越界 ──
  'session_search', 'session_event_read', 'session_event_search',
  'session_event_trace', 'session_trace',
  //
  // ── 终端 / 作业 / worktree：属于开发流程，QQ 里没有正当用途 ──
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal',
  'terminal_close', 'terminal_list',
  'job_output', 'job_list', 'job_kill',
  'create_worktree', 'linux_environment_status',
  //
  // ── 生成类：群里发不出去（image_generate 的产物也无法直传），白烧额度 ──
  'image_generate', 'video_generate', 'x_search',
  //
  // ── 会话上下文管理：群聊里没有正当用途（会改写/丢弃会话上下文）──
  //   ★ 2026-11-20 补：预检一直告警「trim 未声明 context 工具」。
  //   本 hook 是**denylist**，不写进 DENY 就代表"可见" —— 所以这三个确实对
  //   QQ 群会话暴露了。宿主没有这些工具时会自动过滤（不报错），但一旦宿主升级
  //   提供了它们，群里模型就能调用来丢弃上下文，属于越界能力。明确裁掉。
  'context_memo', 'context_compact', 'context_drop',
  //
  // ── 目标 / 日程：群里定时靠扩展包的 schedule_timer（scoped），宿主这组裁掉更干净 ──
  'create_goal', 'get_goal', 'update_goal',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
];

/**
 * ★ 2026-11-18 预留：以下能力**明确不裁**，为后续需求留位 ——
 *
 *   · 私聊（c2c）：本 hook 只按 cwd 判定，私聊与群聊走同一条链路。
 *     私聊要用的工具（send_media / qq_send / people_memo / her_taste …）全部保留，
 *     权限差异由 guard 的 OWNER_ONLY 与工具内部的 c2c/group 判定处理，不在这里区分。
 *
 *   · 人格切换：走 hooks/persona-from-file.mjs + 任务中心热同步，**不占工具槽位**，
 *     因此无需在此登记。将来若改成模型可调用的工具（如 persona_switch），
 *     因为是新增名字、默认不在 DENY 里 ⇒ 自动可见，无需回来改本文件。
 *
 *   · 语音收发：发送走 send_media 的 voice 参数（不在 DENY 即可见），
 *     入站语音走 inbound 的媒体转附件链路；将来若加 tts/asr 工具，
 *     同样因为默认不在 DENY 里而自动可用。
 *
 *   ⇒ 这就是改用 DENY 的核心收益：**新增能力无需回来改这个文件**。
 */

// ★ 保留但可控：以下**不裁**，靠 guard 做执行层门禁 ——
//   write / edit / read / glob / grep / present / todo_write（HEAVY_WRITE_TOOLS，需明确指令）
//   bash（OWNER_ONLY，仅主人）
//   qq_memory / session_*/broadcast_send/group_*（OWNER_ONLY 或工具内部自带权限）
//   web_search / web_fetch / read_image / ask_user_question（日常能力）
//   以及所有未列出的新工具 —— 新增能力默认可用，不需要回来改这个文件。

const CWD_PREFIX = `${WORKSPACE_ROOT}/Bot`;

/** 从 restrict() 的报错里取出「known global tools」清单，再交一次交集 */
function restrictAgent(agent, allow, logger, diag) {
  let tools;
  try { tools = agent?.ctx?.tools ?? agent?.ctx?.get?.('tools'); } catch { tools = undefined; }
  if (!tools || typeof tools.restrict !== 'function') {
    diag?.('restrict-fail', { reason: 'no-tools-restrict', hasTools: Boolean(tools) });
    return { ok: false, allowUsed: [] };
  }
  /**
   * ★ 2026-11-08 重要认知（读源码确认，不是猜）：
   *
   * `tools.restrict()` 只接受 **`restrictableNames`** —— 即「继承/全局层」的工具名。
   * 而扩展包用 `applyExtToolVisibility(agentCtx)` 注册的扩展工具
   * （`group_birthday` / `group_history` / `qq_send` …）
   * 是 **scoped 注册**，只进 `knownNames`，**不进 `restrictableNames`**
   * （dsh-tools 源码：`own.tools.entries()` 只 add 到 knownNames）。
   *
   * 后果：名单里若含 scoped 名，首次 `restrict` 会抛
   *   `tools.restrict() names unknown global tool "xxx"; known global tools: ...`
   * 这正是下面两条降级存在的历史原因。
   *
   * ⚠️ 但「scoped 注册」有个好性质：**它们本来就不受 restrict 影响**
   *   （源码：`Restrictions intersect; scoped registrations remain visible`）。
   *   所以从 allow 里剔除 scoped 名 **不影响那些工具继续可见** —— 功能零损失。
   *
   * 返回 `{ ok, allowUsed }` 以便诊断落盘看出「到底按哪份名单剪的」。
   */
  /**
   * 递归尝试剪枝；成功时返回 `{ ok: true, allowUsed }`，失败返回 `{ ok: false, allowUsed: [] }`。
   *
   * ⚠️ 不要 monkey-patch `tools.restrict`（那是 cordis 服务对象，改了会污染其它使用者）。
   * 用「返回值携带」的方式拿到最终名单。
   */
  const attempt = (names, phase) => {
    try {
      tools.restrict({ deny: names });
      return { ok: true, allowUsed: names, phase };
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      // ① `unknown global tools "a,b,c"` → 这些名字**不可剪**（scoped 注册），从 allow 剔除
      const unknownMatch = /unknown global tool(?:s)?\s*["“]([^"”]+)["”]/i.exec(msg);
      if (unknownMatch) {
        const bad = new Set(unknownMatch[1].split(',').map((s2) => s2.trim().replace(/^"|"$/g, '')).filter(Boolean));
        const filtered = names.filter((n) => !bad.has(n));
        if (filtered.length && filtered.length !== names.length) {
          return attempt(filtered, `${phase}>drop-unknown`);
        }
      }
      // ② `known global tools: a,b,c` → 取交集（兜底，报错格式可能变）
      // ★ 诊断：把报错里的完整 known 名单落盘（一次性），确认到底哪些可剪
      if (at >= 0) {
        try { diag?.('known-list', { names: msg.slice(at + marker.length).slice(0, 2000) }); } catch { /* ignore */ }
      }
      const marker = 'known global tools:';
      const at = msg.indexOf(marker);
      if (at >= 0) {
        const known = new Set(
          msg.slice(at + marker.length).split(',').map((s) => s.trim()).filter((s) => s && s !== '(none)'),
        );
        const filtered = names.filter((n) => known.has(n));
        if (filtered.length && filtered.length !== names.length) {
          return attempt(filtered, `${phase}>intersect`);
        }
      }
      // ⚠️ 只在**最终失败**时写一行（成功路径的中间重试不落盘，否则日志噪音大）
      diag?.('restrict-fail', { phase, err: msg.slice(0, 260), tried: names.length });
      try { logger?.warn?.(`[trim-agent-tools] restrict 失败(${phase}): ${msg.slice(0, 160)}`); } catch { /* ignore */ }
      return { ok: false, allowUsed: [] };
    }
  };

  return attempt(allow, 'first');
}

export async function run(env) {
  const ctx = env?.ctx;
  const logger = env?.logger;
  if (!ctx) return 'no-ctx';

  const seen = new WeakSet();
  let trimmed = 0;

  let diagDone = false;
  /** 一次性诊断：把真实情况写文件（logger 实测被吞，只能落盘）。 */
  const diag = (tag, data) => {
    try {
      const p = `${process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home'}/.dsh/data/dsh-anti-ai-persona/trim-diag.log`;
      appendLogRotating(p, `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`, 'utf8');
    } catch { /* ignore */ }
  };

  /**
   * 对**单个 agent** 尝试剪枝。
   *
   * 🔴 2026-11-08 修（真机实测：剪枝**从未生效**，日志 0 条「已剪枝」）：
   *
   * 病因（三层，逐层证实）：
   *   ① 原实现靠 `ctx.get('agents').list()` 枚举 agent —— 但 `agents` 的 store 只由
   *      `register/enter` 写入，QQ agent 是**网关启动后**才创建的，
   *      而本 hook 在 `runStartupHooks` 阶段就开始跑 → 启动瞬间列表为空；
   *      之后 3s 轮询虽会重试，但实测始终拿不到（列表恒空）。
   *   ② 原 `agent/created` 监听写的是 `() => tick()` —— **完全丢弃了 payload**，
   *      只是重跑那个拿不到 agent 的函数，等于没有监听。
   *   ③ 原判据还要求 `agent.ctx.get('qqChannel')`，而本机**全仓无任何 qqChannel provide 点**
   *      （那是 QQBot 云端版的服务名）→ 恒 false → 永远 `continue`。
   *
   * 修法（DSH 官方推荐路径）：
   *   `agent/created` 的 payload 实测形状为 `{ agent, source, signal }`
   *   （见 `dsh-agent/lib/index.js` 的 `announce()`：`ctx.serial(carrier, "agent/created", { agent: entry.agent, source })`），
   *   而且它是**在 agent 作用域里 serial 派发**，此时 `agent.ctx.tools` 已可用。
   *   ⇒ 直接从 `payload.agent` 拿对象，不再依赖 `agents.list()`。
   *
   * 判据只按 cwd（`{WORKSPACE_ROOT}/Bot`）：
   *   · QQ agent 恒定在该工作区（会话目录名 `--storage-emulated-0-DSH-Bot--` 可证）
   *   · web 会话 cwd 不匹配 → 不会被误剪
   *
   * 安全性：`tools.restrict` 只裁「全局层/继承层」工具，
   *   agent 自己 `tools.register()` 的通道工具（reply_gate / send_media / qq_send…）
   *   **保持可见**（dsh-tools 源码：`Restrictions intersect; scoped registrations remain visible`）。
   */
  const trimOne = (agent) => {
    if (!agent || seen.has(agent)) return false;
    let cwd = '';
    try { cwd = String(agent.session?.header?.cwd ?? agent.session?.cwd ?? ''); } catch { /* ignore */ }
    // 路径边界：必须正好等于前缀，或前缀 + '/'（防 `${WORKSPACE_ROOT}/BotX` 误匹配）
    if (!(cwd === CWD_PREFIX || cwd.startsWith(CWD_PREFIX + '/'))) {
      return false;
    }
    const res = restrictAgent(agent, DENY, logger, diag);
    if (!res.ok) {
      // 失败**不记入 seen** → 下次事件/轮询重试
      diag('trim-fail', {
        cwd,
        hasCtx: Boolean(agent?.ctx),
        hasTools: Boolean(agent?.ctx?.tools),
        hasRestrict: typeof agent?.ctx?.tools?.restrict,
      });
      return false;
    }
    seen.add(agent);
    trimmed++;
    // allowUsed 才是**真正生效**的名单（scoped 注册的扩展工具会被自动剔除，
    // 但它们本身不受 restrict 影响，所以功能零损失）
    diag('trimmed', {
      n: trimmed,
      requested: DENY.length,
      allowed: res.allowUsed.length,
      phase: res.phase,
      cwd,
      droppedScoped: DENY.filter((n) => !res.allowUsed.includes(n)),
    });
    try {
      logger?.info?.(`[trim-agent-tools] 已剪枝 QQ agent 工具（第 ${trimmed} 个，生效 ${res.allowUsed.length}/${DENY.length} 类继承工具）`);
    } catch { /* ignore */ }
    return true;
  };

  /** 轮询兜底：枚举当前所有 agent（可能为空，只是兜底）。 */
  const tick = () => {
    let list = [];
    try {
      const agents = ctx.get?.('agents');
      list = agents?.list?.() ?? [];
    } catch (e) {
      diag('agents-list-throw', { err: String(e) });
      return;
    }
    if (!diagDone) {
      diagDone = true;
      diag('tick-first', {
        agents: list.length,
        info: list.slice(0, 5).map((a) => ({
          cwd: String(a?.session?.header?.cwd ?? a?.session?.cwd ?? '(空)'),
          hasTools: Boolean(a?.ctx?.tools),
          hasRestrict: typeof a?.ctx?.tools?.restrict,
        })),
      });
    }
    for (const agent of list) trimOne(agent);
  };

  tick();

  /**
   * ★ 主力路径：`agent/created`。
   *
   * payload 实测形状 `{ agent, source, signal }`（dsh-agent 的 `announce()`），
   * 直接取 `payload.agent` 剪枝 —— **不再** `() => tick()` 丢弃 payload。
   *
   * 事件不存在（旧宿主）时 `ctx.on` 会抛/返回 undefined，已 try-catch 兜底，
   * 此时仍有 3s 轮询打底（虽然它本身可能拿不到列表）。
   */
  let offCreated;
  try {
    offCreated = ctx.on?.('agent/created', (payload) => {
      try {
        const ag = payload?.agent;
        if (!ag) { diag('created-no-agent', { keys: Object.keys(payload ?? {}).slice(0, 8) }); return; }
        trimOne(ag);
      } catch (e) { diag('created-throw', { err: String(e) }); }
    });
  } catch (e) { diag('created-listen-fail', { err: String(e) }); }

  // ★ 2026-11-05 阶段 3 收编：节律交给中央调度器（tasks.json 的 `ext-trim-agent-tools`）。
  //   注：这是**安全面**，但风险比想象的低 —— `agent/created` 事件是主力路径，
  //   新 QQ agent 一创建就立刻剪枝；这道轮询只兜底「事件漏了 / plugin provide 晚于创建」的边角。
  //   节律仍保持 3000（不降频）：安全面的生效窗口不该被拉长。
  registerWithFallback('trim-agent-tools', () => tick(), {
    env, fallbackMs: 3000, label: 'trim-agent-tools', meta: { id: 'ext-trim-agent-tools' },
  });

  try {
    env?.registerDispose?.(() => { try { if (typeof offCreated === 'function') offCreated(); } catch { /* ignore */ } });
  } catch { /* ignore */ }
  return `ok(allow=${DENY.length})`;
}
