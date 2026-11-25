/**
 * pair-relation/infer.mjs — 「关系可见」纯函数推断层
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件：
 *   现有的关系数据是「她 → 群友」单向好感度（在 dsh-bnnbotbox 里），
 *   而「关系可见」要的是「群友 A ↔ 群友 B」的成对关系。两者维度不同：
 *   —— 单向好感回答的是「她怎么看某个人」；
 *   —— 成对 close 回答的是「群里谁和谁熟」。
 *   本文件负责把「消息流」这种最原始的事实，转成成对互动计数，
 *   供下游判定 close（熟）。只从「互动」推断，绝不碰「情绪」：
 *   情绪是上游人格/好感度的事，混进来会污染成对关系的纯度。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纯函数纪律（务必守住）：
 *   · 无 IO、无 Date.now()（时间一律从入参 t 来）、无随机数；
 *   · 永不抛错：坏输入（非数组、字段缺失、时间非数字）返回空结果或跳过。
 *   这样本文件可以被任意次重放 / 单测，不依赖外部状态。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 踩过的坑：
 *   ① pairKey 必须「排序后拼接」——不能按调用顺序拼。A@B 和 B@A 是同一对，
 *      若不排序，key 会变成两个，互动被拆散，永远凑不到阈值。
 *   ② 正则提取 @提及 时，`/…/g` 的 RegExp 对象有 lastIndex 状态，跨调用复用
 *      同一个正则对象会导致第二次 exec 从上次位置继续、漏匹配。所以这里
 *      每次调用新建正则（或复制 source），不共享带 g 的实例。
 *   ③ 「连续发言」判定前必须先把空文本/机器人消息滤掉，否则相邻性会被
 *      垃圾消息打断（A、空消息、B 三连，A↔B 会被错误拆成不相邻）。
 *   ④ 自 @ 不算互动：A 消息里 @ 自己，不产生 A↔A 的 pair。
 */

/** 互动次数 ≥ 该值才视为 close（熟）。 */
export const CLOSE_THRESHOLD = 10;

/** 「连续发言」判定窗口：相邻两条消息时间差 < 该毫秒数。 */
const CONVO_WINDOW_MS = 120000;

/** 机器人自己 / 被忽略的发送者 openid（不参与成对关系）。 */
const IGNORED_SENDERS = new Set(['self', 'robot']);

/**
 * 两个 openid 排序后拼接成无向键。
 * 保证 pairKey(a, b) === pairKey(b, a)，形如 `"A|B"` 且 A < B。
 */
export function pairKey(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * 从消息文本里提取所有 `<@32位hex>` 提及的 openid，去重返回。
 * 空文本 / 非字符串返回 []。
 */
export function mentionsIn(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  // 每次调用新建正则，避免共享 /g 实例的 lastIndex 状态坑。
  const re = /<@([0-9A-Fa-f]{32})>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 从消息数组推断成对互动次数。
 *
 * @param {Array<{s:string, x:string, t:number}>} messages
 *   消息流，s=发送者 openid，x=文本内容，t=时间戳 ms。假定已按群内时间排序，
 *   且已过滤为同一群聊（消息体不含群 id 字段，群维度由上层调用方保证）。
 * @returns {Map<string, number>} key=pairKey，value=互动次数。
 *
 * 规则：
 *   ① A 的消息里 @ 了 B → A↔B +1（一条消息 @ 多人，每个被 @ 者各 +1，去重）；
 *   ② A、B 相邻两条不同发送者、时间差 < 2 分钟 → A↔B +1；
 *   ③ 忽略 s === 'self' 或 s === 'robot'；
 *   ④ 忽略文本为空的。
 */
export function inferInteractions(messages) {
  const map = new Map();
  if (!Array.isArray(messages)) return map;

  const bump = (a, b) => {
    const k = pairKey(a, b);
    map.set(k, (map.get(k) ?? 0) + 1);
  };

  // 先把「有效消息」筛出来（规则③④），后续两条规则共用这份有效流，
  // 保证「连续发言」的相邻性不被垃圾消息打断。
  const valid = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const s = msg.s;
    const x = msg.x;
    if (IGNORED_SENDERS.has(s)) continue;
    if (typeof x !== 'string' || x.trim() === '') continue;
    valid.push(msg);
  }

  // 规则①：@ 提及
  for (const msg of valid) {
    const s = msg.s;
    for (const id of mentionsIn(msg.x)) {
      // 自 @、或 @ 机器人自己，不构成成对关系。
      if (id === s || IGNORED_SENDERS.has(id)) continue;
      bump(s, id);
    }
  }

  // 规则②：相邻不同发送者、2 分钟内连续发言
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    const cur = valid[i];
    if (prev.s === cur.s) continue;
    const tp = Number(prev.t);
    const tc = Number(cur.t);
    if (!Number.isFinite(tp) || !Number.isFinite(tc)) continue;
    if (Math.abs(tc - tp) < CONVO_WINDOW_MS) {
      bump(prev.s, cur.s);
    }
  }

  return map;
}

/**
 * 从互动 Map 筛出达到 close 阈值的 pair。
 *
 * @param {Map<string, number>} interactions 互动计数 Map（inferInteractions 输出）。
 * @param {number} [threshold=CLOSE_THRESHOLD] 阈值，非法/非正时回落到 CLOSE_THRESHOLD。
 * @returns {Array<{a:string, b:string, key:string, interactions:number}>} a < b 保证。
 */
export function closePairs(interactions, threshold = CLOSE_THRESHOLD) {
  if (!(interactions instanceof Map)) return [];
  let limit = Number(threshold);
  if (!Number.isFinite(limit) || limit <= 0) limit = CLOSE_THRESHOLD;

  const out = [];
  for (const [key, count] of interactions.entries()) {
    const n = Number(count);
    if (!Number.isFinite(n) || n < limit) continue;
    const [a, b] = key.split('|');
    out.push({ a, b, key, interactions: n });
  }
  return out;
}

export default {
  CLOSE_THRESHOLD,
  pairKey,
  mentionsIn,
  inferInteractions,
  closePairs,
};
