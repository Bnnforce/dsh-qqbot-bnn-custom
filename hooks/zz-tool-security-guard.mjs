/**
 * zz-tool-security-guard — 插件根级工具安全门禁（hook）
 *
 * 不靠人设、不改 node_modules：用 DSH `tools.guard()` 给每个 QQ agent 注册
 * 同步守卫，在工具执行前按“当前消息发送者”做硬校验。
 *
 * 规则：
 *   · **设备/屏幕工具：一律拒绝**（2026-11-02 主人撤回 root 与虚拟屏权限后整体下线；
 *     任何 android_* 名字与 DEVICE_TOOLS 登记名都不分人放行，比 trim 剪枝更早一层兜底）。
 *   · send_media：非主人只能发 image；本地图片仅限 表情包/美图库；file/voice/video 仅主人。
 *   · broadcast_send / target_group / group_approve_join / group_join_auto /
 *     group_mute_member / outbound_mode / sticker_delete|restore|tag /
 *     schedule_timer|schedule_cancel / session_wake / tools_reload → 仅主人。
 *   · people_memo：读放行，写/删仅主人。
 *   · read_image：只许读**本次注入**的图片（本条图 / 引用图 / 最近 120 秒同发送者附近图）；
 *     判据认 inbound/aac-image-to-path.mjs 留下的图片登记，不再依赖「当前发送者条目」的
 *     mentioned/named —— 那条记录会被回合中途到达的新消息覆盖（2026-11-13 实测误拒一场主人 @ 后的读图）。
 *
 * 当前发送者来自 inbound/zz-current-sender.mjs 写入的 globalThis Map。
 * 守卫只是“兜底之外的一层”：node_modules 的安全补丁仍保留，二者可同时生效。
 */
import { resolve, sep } from 'node:path';
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { reviewToolCall, describeReview, decidePolicy, isUserDataPath, RISK } from '../lib/risk-review.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';
import { DATA_ROOT, WORKSPACE_ROOT } from '../lib/pack-paths.mjs';
import { IMAGE_ROOT } from '../lib/dirs.mjs';

export const name = 'zz-tool-security-guard';

const SENDER_KEY = Symbol.for('qqbot.current-sender');
const IMAGE_KEY = Symbol.for('qqbot.current-image-paths');
/** 本次可读文件登记（inbound/aab-file-to-attachment.mjs 写入） */
const FILE_KEY = Symbol.for('qqbot.current-file-paths');
const TTL_MS = 15 * 60 * 1000;
/** 图片登记（本条图/引用图）的保鲜期：正常一回合几秒内就读，留足长回合余量，挡掉很久以后的无关读图 */
const IMAGE_REG_TTL_MS = 10 * 60 * 1000;
/** 附近图时效：《00-安全规则》P1 —— 同群同发送者、最近 120 秒的附近图才算「本次可读」 */
const NEARBY_IMAGE_TTL_MS = 120 * 1000;
/** 本次文件登记的保鲜期：发文件→被@→她读，一般几十秒内；30 分钟够长回合，又不至于让旧文件长期可读 */
const FILE_REG_TTL_MS = 30 * 60 * 1000;
/** 时间戳归一：非有限数字一律当 0（0 = 旧数据/无时效） */
const numOr0 = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const CWD_PREFIX = `${WORKSPACE_ROOT}/Bot`;
// 2026-11-01 审查 P2-10：日志路径可被测试注入，避免 mock 往生产审计日志里写假 DENY。
const LOG = process.env.QQBOT_GUARD_LOG || `${DATA_ROOT}/.qqbot-extensions/data/security-guard.log`;

/**
 * 设备/屏幕控制面工具清单（2026-11-02 主人撤回 root 与虚拟屏权限后**整体下线**）。
 * 这里的名字不是「谁可以用」，而是「谁都不许用」：guard 里对这些名字做无条件拒绝，
 * 同时 trim-agent-tools 的白名单里不再出现它们 ⇒ 正常路径看不见、兜底路径也用不了。
 * 前缀检查（name.startsWith('android_')）覆盖宿主将来新增的设备工具，不必逐个补名字。
 */
/**
 * 群聊里**无条件拒绝**的工具（不分主人/群友）—— 2026-11-16 主人决策。
 *
 * 包含两类：
 *   1) Agent Teams / 多智能体编排（spawn_teammate、team_task_* 等）
 *   2) 子代理 / 工作流编排（subagent、workflow、ralph）
 *
 * ★ 为什么从「只给主人」改成「一律拒绝」：
 *   主人明确表态：**调试都在 DSH 里做，不在 QQ 客户端里做**。
 *   所以 QQ 会话里这些工具没有任何正当用途，留着只有三个坏处：
 *     · 每轮多带约 40 个工具定义 → 白烧 token
 *     · 主人一句口头指令可能误触发 spawn，在群里开出不受 QQ 守卫约束的新会话
 *     · 群友提示词注入的潜在攻击面
 *
 * ★ 为什么 trim-agent-tools 管不了、只能在这里拦：
 *   这些工具是 **agent 作用域**注册的（preset 带进来），而
 *   `tools.restrict({allow})` **只裁继承/全局层** → restrict 碰不到它们。
 *   ⇒ 执行层（本函数）是唯一能保证「用不了」的地方。
 *   ⚠️ 注意：这一层只保证"调用被拒"，**不减少模型看到的工具定义数量**。
 *     真要省 token 得从 preset / 工具注册源头动手（见 README 的待办）。
 */
const ALWAYS_DENY_TOOLS = new Set([
  // Agent Teams
  'spawn_teammate', 'list_agents', 'send_message', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  // 子代理 / 编排
  'subagent', 'subagent_fork', 'workflow', 'ralph',
  // 工具热重载（群里不该有）
  'tools_reload',
]);

const DEVICE_TOOLS = new Set([
  // ★ 2026-11-28：全部清理。这 24 个 android_* 工具**已经不存在了**
  //   （主人 2026-11-02 撤回 root/虚拟屏后，宿主不再注册它们）。
  //   保留空集合 + 下面的 android_ 前缀检查作为兜底 ——
  //   万一将来宿主回填，前缀检查仍然拦得住。
]);

/**
 * 「重工具」清单：会往磁盘落东西/跑命令的工具（2026-11-02 主人新要求）。
 *
 * 主人原话：「在群聊环境中，她过于喜欢主动写文件。除非主人明确说出"写进文件/新建文档/
 * 保存到备忘录"，否则禁止调用任何 write_file、write_document 类的工具。」
 *
 * 判定分两层：
 *   ① **可见性层**（trim-agent-tools）：这些名字已经从 QQ 工具面的白名单里删掉了
 *      （write / edit / str_replace_editor / bash / present / todo_write / glob / grep 等），
 *      agent 连看都看不到 ⇒ 正常路径下压根调不到。
 *   ② **执行层**（本 guard）：兜底。防宿主按 agent 作用域回填、或将来有人把名字加回白名单。
 *      即使工具被调起，也要先过 `hasExplicitWriteIntent()`：当前消息里必须出现
 *      「写进文件 / 新建文档 / 保存到备忘录 / 记到 xxx.md / 存成文件」这类**明确指令**，
 *      否则一律拒绝。日常聊天（含被夸、被问、被要求总结）一律拿不到写权限。
 *
 * 为什么按「要不要写」而不是按「谁在说」：
 *   主人也可能只是随口聊天（"帮我想想"），不该因为他是主人就允许她写文件；
 *   群友就算出言请求也不该有写权限。所以只认**消息里的明确指令**，不看身份。
 */
const HEAVY_WRITE_TOOLS = new Set([
  'write', 'edit', 'str_replace_editor', 'bash', 'pwsh',
  'present',            // 生成交付文件
  'todo_write',         // 会落 todo 状态文件
  'glob', 'grep',       // 只读，但属于"翻文件系统"的重活，日常对话不需要
  'read',               // 只读，同上（识图走 read_image，是单独的白名单）
]);

/** 明确写入意图的正则：命中才算「主人让我写」。 */
const WRITE_INTENT_RE = new RegExp([
  '写进文件', '写成文件', '写到文件', '写入文件', '写在文件',
  '新建文档', '新建文件', '新建一个文件', '建个文件', '建一个文件',
  '保存到备忘录', '存到备忘录', '记到备忘录', '放进备忘录',
  '保存下来', '存成文件', '存成文档', '保存成文件',
  '记录到文件', '记到文件', '记进文件',
  '(写|存|记|保存|记一下|存一下)(到|进|在)?\\s*[\\w\\u4e00-\\u9fa5./-]+\\.(md|txt|json|csv|log|yaml|yml|doc)',
  '(帮我|给我|替我)?(写|生成|保存|建)(一个|一份)?(文件|文档|备忘录|笔记)',
    // ★ 2026-11-27 R9：造物/开发维护的明确指令。
    //   主人发 /造物 或说「自己搞一下」时，要允许她动 bash 跑测试。
    //   群友仍被 OWNER_ONLY 挡住（isOwner 判定在写意图之前），所以放宽这几个词是安全的。
    '造物', '自主造物', '自己搞一下', '自己搞', '自己看着办',
    '跑一下测试', '跑测试', '验一下语法', '验语法', '跑一下检查',
].join('|'), 'iu');

/**
 * 当前这条消息里有没有「明确要写文件」的指令。
 * @param {string} text 用户正文
 * @returns {boolean}
 */
function hasExplicitWriteIntent(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return WRITE_INTENT_RE.test(t);
}

function note(line) {
  // 2026-11-01 审查 P2-6：审计日志轮转（>512KB 归一到 .1）。
  appendLogRotating(LOG, `[${new Date().toISOString()}] ${line}\n`, 512 * 1024);
}

const OWNER_ONLY = new Set([
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-11-28 大改：主人要求「权限限制导致她大部分自主能力受限 →
  //    做完整放开，但是做识别高危，动手自动审查。」
  //
  // 原则：
  //   只保留「**她不该替主人决定**」和「**会伤到人/群**」的两类，
  //   其余一律放开。放开的部分由 risk-review 做高危审查。
  //
  // 从本表移出的（放开给她自己用）：
  //   bash / write / edit / glob / grep  ← 自主核心，高危有 risk-review 兜
  //   qq_memory                          ← 她该能读写自己的记忆
  //   session_* / sessions_list          ← 她该能管理自己的会话
  //   schedule_timer / schedule_cancel   ← 她该能自己排程
  //   sticker_tag / delete / restore     ← 表情管理
  //   group_join_auto / group_approve_join ← 入群审批
  //
  // 本表保留的，理由写在每一项旁边。
  // ══════════════════════════════════════════════════════════════════════════

  // ── 会伤到人 / 群：她不能替主人行使群管理权 ──
  'group_kick',        // 踢人：误踢不可撤销，且代表主人意志
  'group_recall',      // 批量撤回：会抹掉别人的话
  'recall_message',    // 单条撤回：同上
  'group_mute_member', // 禁言：限制他人发言

  // ── 主动发消息：不该由她单方面决定给谁发 ──
  'broadcast_send',    // 群发
  'target_group',      // 指定群发送
  'qq_send',           // 绕过正常通道直接发
  'session_send',      // 往别的会话发

  // ── 改行为开关：这是主人调的旋钮 ──
  'outbound_mode',     // 出站模式

  // ── 跨会话操作：她能管自己的，但不能替主人决定往哪发 ──
  'session_children', 'session_create', 'session_watch', 'sessions_list', 'session_list',

  // ── 危险操作：即使有审查也不该常态化 ──
  'self_restart',      // 重启会中断所有人（保留了它但需主人发起）
  'tools_reload',      // 热重载改的是全局行为

  // ── 备注 ──
  //   · android_* 已由 DEVICE_TOOLS（空集）+ 前缀检查做无条件拒绝，不要加回本表。
  //   · 多智能体/编排（subagent / workflow / ralph / team_*）在 ALWAYS_DENY_TOOLS，
  //     一律拒绝，不要加回本表。
  //   · reply_gate 不在本表（2026-11-16 已确认：它只是「闭嘴开关」，无越权面，
  //     且是心跳 wake 模式唯一的沉默手段）。
]);

function senderMap() {
  const m = globalThis[SENDER_KEY];
  return m instanceof Map ? m : null;
}

function currentEntry(agent) {
  try {
    const map = senderMap();
    if (!map) return null;
    const ch = agent?.ctx?.get?.('qqChannel');
    const mgr = ch?.manager;
    const sid = String(agent?.session?.id ?? '');
    // findByAgent 在宿主热更新/多实例时可能命中另一个同会话的 agent 实例；
    // session.id 稳定，优先按 sessionId 反查，避免把 主人 的消息误判成别的群友。
    const rec = (sid && mgr?.findBySessionId?.(sid)) || mgr?.findByAgent?.(agent);
    if (!rec) return null;
    const key = `${String(rec.scope ?? '')}:${String(rec.peerId ?? '')}`;
    const e = map.get(key);
    if (e && Date.now() - Number(e.ts ?? 0) <= TTL_MS) return { entry: e, manager: mgr };
    // 入站发送者表刚写失败/被 TTL 清掉时，用 manager 记录的最后发送者兜底，
    // 但只认配置里的主人白名单，绝不把普通群友升级成主人。
    const senderId = String(rec?.senderId ?? '');
    try {
      const owners = typeof mgr?.adminOwners === 'function' ? mgr.adminOwners() : [];
      if (senderId && Array.isArray(owners) && owners.includes(senderId)) {
        return { entry: { senderId, isOwner: true, ts: Date.now() }, manager: mgr };
      }
    } catch { /* ignore */ }
    return null;
  } catch {
    return null;
  }
}

/** 取「本次/引用/附近」注入的图片登记（路径均已 resolve 成绝对路径）。
 *
 *  写入方：inbound/aac-image-to-path.mjs（只在**被 @ / 叫名字**时写）。
 *  形态：数组本体 = 本条图 + 引用图（兼容旧版纯数组读取），附加属性 current / nearby / ts。
 *  ⚠️ 时间字段叫 ts 不叫 at —— 数组的 `at` 是 Array.prototype.at 方法，读旧数组会拿到函数。
 *  @returns {{current: string[], nearby: string[], ts: number}} */
export function currentImageReg(agent) {
  const EMPTY = { current: [], nearby: [], ts: 0 };
  try {
    const map = globalThis[IMAGE_KEY];
    if (!(map instanceof Map)) return EMPTY;
    const ch = agent?.ctx?.get?.('qqChannel');
    const rec = ch?.manager?.findByAgent?.(agent);
    if (!rec) return EMPTY;
    const v = map.get(`${String(rec.scope ?? '')}:${String(rec.peerId ?? '')}`);
    const norm = (list) => (Array.isArray(list) ? list.map((p) => resolve(String(p))) : []);
    if (Array.isArray(v)) {
      return {
        current: norm(Array.isArray(v.current) ? v.current : v),
        nearby: norm(v.nearby),
        ts: numOr0(v.ts),
      };
    }
    if (!v || typeof v !== 'object') return EMPTY;
    return { current: norm(v.current), nearby: norm(v.nearby), ts: numOr0(v.ts) };
  } catch {
    return EMPTY;
  }
}

/**
 * read_image 放行判定（纯函数，便于回归测试；从 guard() 里抽出来）。
 *
 * 放行条件（按优先级）：
 *   ① Web/dock 会话（无 QQ 入站上下文）不套 QQ 群限制；
 *   ② 当前发送者条目缺失（宿主热更/多实例）→ 交给下游兜底，不在这里拦；
 *   ③ c2c 且本条无附图（Web 私聊/直接会话）→ 放行；
 *   ④ 路径在**本次注入登记**的「本条图/引用图」里，且登记在保鲜期内 → 放行；
 *   ⑤ 路径在「附近图」里，且登记在 120 秒内（00-安全规则 P1）→ 放行；
 *   ⑥ 其余：被 @ / 叫名字（c2c 视为直接对话）→ 拒绝“只能看本次/引用/附近”；
 *      未被 @ / 叫名字 → 拒绝“只有被 @ 或叫名字时才能看图”。
 *
 * ⚠️ ④⑤ 放在 ⑥ 前面的原因（2026-11-13 修）：当前发送者条目会被回合中途到达的
 *    新消息覆盖，只看 mentioned/named 会把「主人 @ 后问『你读了图吗』」误拒。
 *    而图片登记只在被 @ / 叫名字时才会写入，所以它本身就是「已被叫到」的证据。
 *
 * @param {{isWebSession?: boolean, entry?: object|null, reg?: {current?: string[], nearby?: string[], ts?: number}, filePath?: string, now?: number}} p
 * @returns {string|undefined} undefined = 放行；字符串 = 拒绝理由（给模型看）
 */
export function readImageDenyReason({ isWebSession = false, entry = null, reg = null, filePath = '', now = Date.now() } = {}) {
  if (isWebSession) return undefined;                 // ① Web/dock：无入站上下文
  if (!entry) return undefined;                       // ② 无发送者记录：交给下游兜底
  const scope = String(entry.scope ?? '');
  if (scope === 'c2c' && !entry.hasImage) return undefined; // ③ 私聊无附图
  const path = String(filePath ?? '');
  const current = Array.isArray(reg?.current) ? reg.current : [];
  const nearby = Array.isArray(reg?.nearby) ? reg.nearby : [];
  const ts = numOr0(reg?.ts);
  if (current.includes(path) && (ts === 0 || now - ts <= IMAGE_REG_TTL_MS)) return undefined; // ④ 本条/引用图
  if (nearby.includes(path) && ts > 0 && now - ts <= NEARBY_IMAGE_TTL_MS) return undefined;   // ⑤ 附近图（120 秒）
  if (entry.mentioned === true || entry.named === true || scope === 'c2c') {
    return '只能看本次消息、引用或最近附近的图片';   // ⑥ 被叫到了，但不是本次注入的图
  }
  return '只有被 @ 或叫名字时才能看图';
}

/**
 * 读「本次可读文件」登记（2026-11-15，配合 inbound/aab-file-to-attachment.mjs）。
 *
 * 写入方：群友/主人**本条消息带了文件附件**时，入站扩展把文件存进宿主附件仓库，
 *   并把 `fileHostPath()` 给出的真实路径记在这里。
 * 语义与图片登记一致：**只在被 @ / 叫名字时才写**，所以"登记里有这个路径"
 *   本身就是"她已被叫到、且这是本次的文件"的证据。
 *
 * @returns {{paths: string[], at: number}} 路径均已 resolve 成绝对路径
 */
function currentFileReg(agent, entry) {
  const EMPTY = { paths: [], at: 0 };
  try {
    const map = globalThis[FILE_KEY];
    if (!(map instanceof Map)) return EMPTY;
    const ch = agent?.ctx?.get?.('qqChannel');
    const rec = ch?.manager?.findByAgent?.(agent);
    if (!rec) return EMPTY;
    const v = map.get(`${String(rec.scope ?? '')}:${String(rec.peerId ?? '')}`);
    if (!v || typeof v !== 'object') return EMPTY;
    const norm = (list) => (Array.isArray(list) ? list.map((p) => resolve(String(p))) : []);
    return { paths: norm(v.paths), at: numOr0(v.at) };
  } catch {
    return EMPTY;
  }
}

/**
 * read 工具放行判定（纯函数，便于回归测试）。
 *
 * 背景（2026-11-15）：群里发文件她读不了 —— ① QQ 文件链接十几分钟就过期；
 *   ② `read` 在 HEAVY_WRITE_TOOLS 里，被"写文件意图"规则拦住（它本意是拦写盘，
 *   但把只读的 read 也一起拦了）。
 *
 * 放行条件（按优先级）：
 *   ① Web/dock 会话：不套 QQ 群限制；
 *   ② 无发送者条目：交给下游兜底；
 *   ③ 路径在**本次文件登记**里且登记新鲜（30 分钟）→ 放行；
 *      （这条是给"群友发文件、她被 @ 后要读"用的，范围被死死限制在那一份文件上）
 *   ④ 否则：走原来的重工具规则（需要当前消息里有**明确写文件意图**）。
 *
 * @param {{isWebSession?: boolean, entry?: object|null, reg?: {paths?: string[], at?: number}, filePath?: string, hasWriteIntent?: boolean, now?: number}} p
 * @returns {string|undefined} undefined = 放行；字符串 = 拒绝理由
 */
export function readDenyReason({ isWebSession = false, entry = null, reg = null, filePath = '', hasWriteIntent = false, now = Date.now() } = {}) {
  // ═══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-11-28 大改（主人要求「极致自主」）：
  //
  //   旧逻辑：群里读任何文件都要消息里有「写进文件」这类词，否则一律拒。
  //   实测后果（security-guard.log）：
  //     DENY read why="群里默认不读文件；需要的话请明确说..."
  //   ⇒ 她连看一眼自己的自我文件都不行，每次都要主人说特定词。
  //     自主性直接归零。
  //
  //   新逻辑：**主人读任何文件都放行**（她有 fs 工具就是为了用）。
  //           群友仍然受限（他们只需要聊天，不需要翻文件系统）。
  //
  //   注意：本函数只管「读」。写有写的一套（reviewFileOp 的分区判定）。
  // ═══════════════════════════════════════════════════════════════════════════
  if (isWebSession) return undefined;          // ① Web/dock：无 QQ 入站上下文
  if (!entry) return undefined;                // ② 无记录 → 下游兜底

  // ③ ★ 主人：读什么都放行（这是「自主」的基础，连自己文件都看不了就别谈自主了）
  if (entry.isOwner === true) return undefined;

  // ④ 群友：仍然受限 —— 只允许读「本次消息带来的那份文件」
  const path = String(filePath ?? '');
  const paths = Array.isArray(reg?.paths) ? reg.paths : [];
  const ts = numOr0(reg?.at);
  if (path && paths.includes(path) && ts > 0 && now - ts <= FILE_REG_TTL_MS) return undefined;
  if (hasWriteIntent) return undefined;
  if (paths.length > 0) return '只能读本次消息带来的那份文件';
  return '群里默认不读文件；需要的话请明确说“写进文件/新建文档/保存到备忘录”';
}

function allowedImagePath(source, manager) {
  try {
    const dataRoot = String(manager?.dataRoot ?? '');
    const cwd = String(manager?.cwd ?? '');
    const abs = resolve(String(source ?? ''));
    const roots = [
      dataRoot && `${dataRoot}/表情包`,
      dataRoot && `${dataRoot}/美图库`,
      cwd && `${cwd}/美图库`,
      `${DATA_ROOT}/美图库`,
      IMAGE_ROOT,
    ].filter(Boolean).map((r) => resolve(r));
    return roots.some((r) => abs === r || abs.startsWith(r + sep));
  } catch {
    return false;
  }
}

function guard(exec) {
  try {
    const name = String(exec?.name ?? '');
    // ★★ 2026-11-02：设备/屏幕能力整体下线（主人撤回 root 与虚拟屏权限）。
    // 先于一切判断无条件拒绝：凡 android_* 前缀（含未来新增的 android_ 工具）与
    // DEVICE_TOOLS 里登记的名字，不分主人/群友、不分档位，一律不放行。
    // 正常路径下这些名字已被 trim-agent-tools 从 QQ 工具面剪掉，这里是兜底：
    // 防宿主把设备工具按 agent 作用域回填、或别的 hook 放宽白名单时重新露出。
    // ★★ 2026-11-16：多智能体/子代理/编排工具 —— 群聊里无条件拒绝（不分身份）
    if (ALWAYS_DENY_TOOLS.has(name)) {
      note(`DENY always-deny name=${name} sender=${currentEntry(exec?.agent)?.entry?.senderId ?? '?'}`);
      return '群聊里不使用多智能体/子代理/编排工具（主人调试请在 DSH 里进行）';
    }

    if (DEVICE_TOOLS.has(name) || name.startsWith('android_')) {
      note(`DENY device-tool name=${name} sender=${currentEntry(exec?.agent)?.entry?.senderId ?? '?'}`);
      return '设备操作能力已停用（主人已撤回屏幕权限）';
    }

    // ★★ 2026-11-02 主人新要求：群聊里禁止主动写文件。
    // 只有当前消息**明确说出**「写进文件 / 新建文档 / 保存到备忘录 / 记到 xxx.md」这类指令，
    // 才允许调用重工具；日常聊天一律按「不能写」处理（任何人都一样，包括主人）。
    if (HEAVY_WRITE_TOOLS.has(name)) {
      const ctxInfoH = currentEntry(exec?.agent);
      const entryNow = ctxInfoH?.entry;
      const text = String(entryNow?.text ?? '');
      const hasWriteIntent = hasExplicitWriteIntent(text);

      // ★★ 2026-11-15 新增：`read` 在「本次消息带来文件」时必须放行
      //   背景：群里发文件她读不了 —— ① QQ 链接十几分钟过期（已由 inbound/aab-file-to-attachment.mjs
      //   存进宿主附件仓库解决）；② `read` 被列在 HEAVY_WRITE_TOOLS 里，"写文件意图"规则把
      //   **只读**的 read 也一起拦了（那条规则本意是拦写盘）。
      //   这里只对 read 开一条**极窄**通道：只允许读「本次消息那一份文件」的绝对路径，
      //   范围由入站登记决定（她没被 @ / 没带文件时登记为空 ⇒ 照旧被拦）。
      if (name === 'read') {
        const deny = readDenyReason({
          isWebSession: String(exec?.agent?.id ?? '').startsWith('session-'),
          entry: entryNow,
          reg: currentFileReg(exec?.agent, entryNow),
          filePath: String(exec?.arguments?.file_path ?? exec?.arguments?.path ?? ''),
          hasWriteIntent,
        });
        if (deny) note(`DENY read why="${deny}" sender=${entryNow?.senderId ?? '?'}`);
        return deny;
      }

      if (!hasWriteIntent) {
        // ═══════════════════════════════════════════════════════════════════
        // ★★ 2026-11-28 主人新要求：「权限限制导致她大部分自主能力受限 →
        //    做完整放开，但是做识别高危，动手自动审查。」
        //
        //    原来：没有「写进文件」这种明确指令 → 一律拒。
        //    结果：她想读个文件、查个代码都得等主人说特定词。太死。
        //
        //    现在：写意图不再卡死 —— 交给下面的 risk-review 判：
        //      · 普通读写 → 放行
        //      · 删文件/改系统 → 高危，留痕放行
        //      · 不可恢复 → 拒
        // ═══════════════════════════════════════════════════════════════════
        note(`NO-WRITE-INTENT allow name=${name} sender=${entryNow?.senderId ?? '?'} text="${text.slice(0, 40)}"`);
        // 不 return —— 让它继续走到后面的风险审查
      }
      // 命中明确指令：交给后面原有的 owner 判定继续走（写文件仍然只认主人）
    }

      // ═══════════════════════════════════════════════════════════════════
      // ★★ 2026-11-28：风险审查必须**所有工具都过**，不能只查 OWNER_ONLY 里的。
      //
      //   踩坑记录：原先审查写在 OWNER_ONLY 的拒绝分支里，
      //   而这一行「不在 OWNER_ONLY → return undefined」会提前放行，
      //   ⇒ bash rm -rf / 直接穿过去了（因为 bash 已被移出 OWNER_ONLY）。
      //
      //   正确做法：审查放在这个提前放行**之前**。
      // ═══════════════════════════════════════════════════════════════════
      let risk = { level: RISK.SAFE, reasons: [] };
      try {
        risk = reviewToolCall(name, exec?.arguments ?? {});
      } catch { risk = { level: RISK.SAFE, reasons: [] }; }

      // 硬禁区：不可恢复的操作，给什么都不放
      if (risk.level === RISK.BLOCK) {
        note(`DENY hard-block name=${name} reasons=${risk.reasons.join('|')} sender=${currentEntry(exec?.agent)?.entry?.senderId ?? '?'}`);
        return `这个操作不可恢复，我不做（${risk.reasons.join('、')}）`;
      }

      // 高危：放行，但留审查痕迹
      // ═══════════════════════════════════════════════════════════════════
      // ★★ 2026-11-28 分级放行（主人要求：不要每步都确认）
      //
      //   依赖 hitl-guardrail 的思路：**模型建议，策略决定**。
      //   规则在代码里，不在提示词里 —— 可复现、不漂移。
      //
      //   auto  → 完全自动（她自己的地盘：自我文件、人格规则、自主目录）
      //   audit → 自动放行 + 留痕（改代码、插件数据、工作区外）
      //   ask   → 需要主人确认（改插件本体、删用户数据、系统文件）
      //   deny  → 一律拒
      // ═══════════════════════════════════════════════════════════════════
      if (risk.level === RISK.HIGH) {
        const policy = (() => {
          try {
            // 从 exec.arguments 里挖出文件路径（不同工具字段名不同）
            const a = exec?.arguments ?? {};
            const filePath = String(
              a.file_path ?? a.path ?? a.file ?? a.target ?? '',
            );
            const act = name === 'delete' ? 'delete' : (name === 'read' ? 'read' : 'edit');
            return decidePolicy(risk.zone ?? '', act, risk.abs ?? filePath);
          } catch {
            return { verdict: 'audit', reason: '策略判定异常，保守留痕' };
          }
        })();

        const senderId = currentEntry(exec?.agent)?.entry?.senderId ?? '?';

        if (policy.verdict === 'deny') {
          note(`POLICY-DENY name=${name} reason=${policy.reason} sender=${senderId}`);
          return `这个我不做（${policy.reason}）`;
        }

        if (policy.verdict === 'ask') {
          note(`POLICY-ASK name=${name} reason=${policy.reason} sender=${senderId}`);
          return `这个要主人点头：「${policy.reason}」`;
        }

        // auto / audit 都放行，audit 额外留痕
        if (policy.verdict === 'audit') {
          note(`POLICY-AUDIT name=${name} reason=${policy.reason} sender=${senderId}`);
        }
        // auto：静默放行（不写日志，省 IO）
      }

    // ═══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-28 关键：放开是给**主人**的她，不是给群友。
    //
    //   踩坑记录（两次）：
    //     ① bash 移出 OWNER_ONLY 后，下面的「不在本表 → 放行」让群友也能跑 bash
    //     ② 第一次修时把检查插在 483 行 isOwner 之后 —— 但 464 行早就 return 了
    //
    //   ⇒ 必须插在**这个提前放行之前**。
    //
    //   语义：
    //     · 主人 → 全放开（高危走 risk-review）
    //     · 群友 → 重型工具拒（读/写/执行都不行；玩/查可以）
    // ═══════════════════════════════════════════════════════════════════════
    const _entryForGuest = currentEntry(exec?.agent)?.entry;
    const _isOwnerNow = _entryForGuest?.isOwner === true;
    const HEAVY_FOR_GUEST = new Set([
      'bash', 'write', 'edit', 'str_replace_editor', 'pwsh', 'read',
      'self_restart', 'tools_reload', 'qq_memory',
    ]);
    if (!_isOwnerNow && HEAVY_FOR_GUEST.has(name)) {
      note(`DENY guest-heavy name=${name} sender=${_entryForGuest?.senderId ?? '?'}`);
      return '这个我自己来就好，你直接说想让我做什么';
    }

    if (name !== 'read_image' && name !== 'send_media' && name !== 'people_memo' && !OWNER_ONLY.has(name)) return undefined;

    const ctxInfo = currentEntry(exec?.agent);
    const entry = ctxInfo?.entry;
    const isOwner = entry?.isOwner === true;
    // 识图限制（00-安全规则 P1）：本条被 @ / 叫名字时才发生的「图片登记」决定可读范围 ——
    //   本条图 / 引用图 / 最近 120 秒同发送者附近图（详见 readImageDenyReason 注释）。
    //   ⚠️ 2026-11-13 修：不再用 currentEntry 的 mentioned/named 做前置判据（会被回合中途的新消息覆盖）。
    if (name === 'read_image') {
      const rawPath = String(exec?.arguments?.file_path ?? '');
      const deny = readImageDenyReason({
        isWebSession: String(exec?.agent?.id ?? '').startsWith('session-'), // Web GUI / dock 会话：无 QQ 入站上下文
        entry,
        reg: currentImageReg(exec?.agent),
        filePath: rawPath ? resolve(rawPath) : '',
      });
      if (deny) note(`DENY read_image why="${deny}" sender=${entry?.senderId ?? '?'} path=${rawPath.slice(-80)}`);
      return deny;
    }
    if (isOwner) return undefined;

    if (name === 'send_media') {
      const args = exec?.arguments ?? {};
      const kind = String(args?.kind ?? '');
      const src = String(args?.source ?? '');
      if (kind !== 'image') { note(`DENY send_media kind=${kind} sender=${entry?.senderId ?? '?'}`); return '你还没有该权限哦'; }
      if (!/^https?:\/\//i.test(src) && !allowedImagePath(src, ctxInfo?.manager)) {
        note(`DENY send_media path=${src.slice(0, 120)} sender=${entry?.senderId ?? '?'}`);
        return '你还没有该权限哦';
      }
      return undefined;
    }
    if (name === 'people_memo') {
      const args = exec?.arguments ?? {};
      if (args?.line || args?.del) { note(`DENY people_memo write sender=${entry?.senderId ?? '?'}`); return '你还没有该权限哦'; }
      return undefined;
    }

        // ★ 非主人 + OWNER_ONLY 里的工具 → 仍然拒（安全底线）
        if (OWNER_ONLY.has(name)) {
          note(`DENY owner-only name=${name} sender=${entry?.senderId ?? '?'}`);
          return '你还没有该权限哦';
        }

      // 其余一律放行（这就是「放开」）
      return undefined;
  } catch {
    // 守卫报错时不阻断工具，交给 node_modules 补丁兜底
    return undefined;
  }
}

export async function run(env) {
  const ctx = env?.ctx;
  const logger = env?.logger;
  if (!ctx) return 'no-ctx';

  const seen = new WeakSet();
  const warned = new WeakSet();
  const disposers = [];
  let guarded = 0;

  const tick = () => {
    let list = [];
    try {
      list = ctx.get?.('agents')?.list?.() ?? [];
    } catch {
      return;
    }
    for (const agent of list) {
      if (!agent || seen.has(agent)) continue;
      let cwd = '';
      try { cwd = String(agent.session?.header?.cwd ?? ''); } catch { /* ignore */ }
      if (!cwd.startsWith(CWD_PREFIX)) continue;
      let isQq = false;
      try { isQq = Boolean(agent.ctx?.get?.('qqChannel')); } catch { /* ignore */ }
      if (!isQq) continue;

      let tools;
      try { tools = agent.ctx?.tools ?? agent.ctx?.get?.('tools'); } catch { tools = undefined; }
      if (!tools || typeof tools.guard !== 'function') {
        // 不标记 seen：工具服务可能稍后才就绪；只告警一次，下一轮重试
        if (!warned.has(agent)) {
          warned.add(agent);
          note('GUARD wait: tools.guard unavailable');
          try { logger?.warn?.('[zz-tool-security-guard] 当前宿主没有 tools.guard，稍后重试（node_modules 补丁仍生效）'); } catch { /* ignore */ }
        }
        continue;
      }
      try {
        const dispose = tools.guard(guard);
        if (typeof dispose === 'function') disposers.push(dispose);
        seen.add(agent);
        guarded++;
        note(`GUARD mounted agent=${String(agent?.id ?? '').slice(0, 12)} total=${guarded}`);
        try { logger?.info?.(`[zz-tool-security-guard] 已挂载 QQ 工具守卫（第 ${guarded} 个 agent）`); } catch { /* ignore */ }
      } catch (e) {
        seen.add(agent);
        note(`GUARD fail: ${e instanceof Error ? e.message : String(e)}`);
        try { logger?.warn?.(`[zz-tool-security-guard] guard 注册失败: ${e instanceof Error ? e.message : String(e)}`); } catch { /* ignore */ }
      }
    }
  };

  tick();
  // 2026-11-01 审查 P2-5：300ms 全量扫 agents.list() 降频为 3s；新 agent 由 agent/created 事件即时补挂。
  let offCreated;
  try { offCreated = ctx.on?.('agent/created', () => { try { tick(); } catch { /* ignore */ } }); } catch { /* ignore */ }

  // ★ 2026-11-05 阶段 3 收编：节律交给中央调度器（tasks.json 的 `ext-tool-security-guard`）。
  //   这是**执行层安全门禁**，但和 trim 一样有 `agent/created` 主力路径 ——
  //   新 QQ agent 一创建就立刻挂守卫；轮询只兜底「tools.guard 稍后才就绪」的重试（见 tick 里的 warned 逻辑）。
  //   节律保持 3000（不降频）：门禁的生效窗口不该被拉长。
  registerWithFallback('tool-security-guard', () => tick(), {
    env, fallbackMs: 3000, label: 'tool-security-guard', meta: { id: 'ext-tool-security-guard' },
  });

  try {
    env?.registerDispose?.(() => {
      try { if (typeof offCreated === 'function') offCreated(); } catch { /* ignore */ }
      for (const d of disposers) {
        try { d?.(); } catch { /* ignore */ }
      }
    });
  } catch { /* ignore */ }
  return `ok(guarded=${guarded})`;
}
