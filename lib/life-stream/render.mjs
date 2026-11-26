/**
 * life-stream/render — 把活动类型渲染成一句人话（R7.2 · 零 LLM · 纯函数）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条硬约束（改模板前先读）
 *
 *   ① **模板池每类 ≥8 句，随机取**。
 *      生活流唯一的消费方是「心跳引用」——同一句话连着出现四次，
 *      被引用的价值就是 0，还会被她自己说出来变成复读机（R7.2 §6.1 高风险项）。
 *
 *   ② **每句都必须带真实变量**（时刻 / 时段 / 日期 / 星期 / 情绪值）。
 *      纯静态句子 = 一条永远不变的字符串，24 小时写 24 遍一模一样的，
 *      日志一眼就看得出是机器在自言自语。
 *
 *   ③ **严禁编造具体地点、人名、事件**（R7.2 §「明确不做」）。
 *      没有「去了公园」「遇见小张」「今天下雨」——环境数据我们**没有**，
 *      写出来就是虚假记忆，违背诚实原则。
 *      允许的只有：真实时间（可算）、真实日期（可算）、真实情绪值（传进来的）。
 *      所以模板里出现的日期一律**由 now 推导**，不是硬编码的故事。
 *
 * ── 输出净化 ────────────────────────────────────────────────────────────────
 *   scrubId() 兜底抹掉 32 位 hex（openid 形状）。模板本身不会拼 id，
 *   但生活日志会被别的模块（关系/群史）拿来拼，多一道闸门成本几乎为零。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/* ──────────────────────────────────────────────────────────────
 * 一、时间 / 情绪 → 人话变量
 * ────────────────────────────────────────────────────────────── */

const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 0-23 → 中文数字（十 / 十一 / 二十 / 二十三）。
 *
 * ⚠️ 时刻读法跟「个数量词」不同：2 点说「两点」不说过「二点」，
 *    12 点说「十二点」。所以点前用 HOUR_CN 覆盖表，不用通用 cnNum。
 */
function cnNum(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 0) return '零';
  if (v < 10) return CN_DIGIT[v];
  if (v === 10) return '十';
  if (v < 20) return `十${CN_DIGIT[v - 10]}`;
  const tens = Math.floor(v / 10);
  const unit = v % 10;
  return `${CN_DIGIT[tens]}十${unit ? CN_DIGIT[unit] : ''}`;
}

/**
 * 时刻专用：0-23 → 「几点」里的那个词。
 *
 * 只有 2 点特殊（口语里是「两点」不是「二点」）。其余走 cnNum。
 * 这个坑是 2026-11-26 端到端模拟里读出来的：渲染出了「二点，心里平静」。
 */
function hourCnOf(hour) {
  const v = Math.trunc(Number(hour));
  if (v === 2) return '两';
  return cnNum(v);
}

/**
 * 时段词。
 *
 * 分得比「上午/下午」细一点：生活流里「傍晚」和「下午」的语感差很多，
 * 而这正好是唯一免费的"真实感"来源。
 */
function slotWord(hour) {
  if (hour < 3) return '深夜';
  if (hour < 6) return '凌晨';
  if (hour < 9) return '早上';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 20) return '傍晚';
  if (hour < 23) return '晚上';
  return '夜里';
}

/** 一天过到哪儿了（check_time 用，避免 8 句都只说"几点了"）。 */
function dayProgress(hour, minute) {
  const mins = hour * 60 + minute;
  if (mins < 9 * 60) return '一天还长';
  if (mins < 12 * 60) return '上午快过完了';
  if (mins < 14 * 60) return '刚过中午';
  if (mins < 18 * 60) return '下午还有一段';
  if (mins < 21 * 60) return '一天差不多过完了';
  return '该收尾了';
}

/**
 * 情绪值 → 描述词（**只描述，不打分**）。
 *
 * 心理状态架构说明的红线：注入语里不出现数字。
 * 导出文本同理 —— 写「发闷」而不是「心情 0.32」。
 *
 * ⚠️ 选词标准是**四个语境都要读得通**（2026-11-26 定）：
 *    「心里X」「心情X」「有点X」「X。」
 *    所以不用「平静」（"有点平静"别扭），改用「发闷」这类能配"有点"的词。
 */
function moodWord(mood) {
  const v = Number(mood);
  if (!Number.isFinite(v)) return '平静';
  if (v < 0.2) return '低落';
  if (v < 0.4) return '发闷';
  if (v < 0.6) return '平静';
  if (v < 0.8) return '轻快';
  return '高兴';
}

/**
 * 收齐一句模板需要的所有变量。
 *
 * 全部由 now 推导，**不读文件、不查历史**：渲染必须是纯的，
 * 否则同 seed 复现不了，测试也就锁不住。
 *
 * @param {object} state
 * @param {number|string|Date} now
 */
function makeVars(state, now) {
  const d = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date(now);
  const safe = Number.isFinite(d.getTime()) ? d : new Date();

  const hour = safe.getHours();
  const minute = safe.getMinutes();
  const y = safe.getFullYear();
  const mo = safe.getMonth() + 1;
  const day = safe.getDate();

  // 三天前：recall 用。是**真实日期**（由 now 算出来的），不是编造的故事。
  const past = new Date(safe.getTime() - 3 * 86400000);
  const pastCn = `${past.getMonth() + 1}月${past.getDate()}日`;
  const yesterday = new Date(safe.getTime() - 86400000);

  return {
    y,
    mo,
    day,
    hour,
    minute,
    hourCn: hourCnOf(hour),
    clock: `${pad2(hour)}:${pad2(minute)}`,
    hourText: `${hourCnOf(hour)}点${minute ? cnNum(minute) + '分' : ''}`,
    slot: slotWord(hour),
    period: slotWord(hour),
    dayProgress: dayProgress(hour, minute),
    dateCn: `${mo}月${day}日`,
    fullDateCn: `${y}年${mo}月${day}日`,
    weekdayCn: `星期${WEEK_CN[safe.getDay()]}`,
    yesterdayCn: `${yesterday.getMonth() + 1}月${yesterday.getDate()}日`,
    pastCn,
    moodWord: moodWord(state?.mood?.mood),
    energyWord: energyWord(state?.mood?.energy),
  };
}

/**
 * 精力值 → 描述词。
 *
 * ⚠️ 必须能**独立作谓语**（模板里常写成「…，${energyWord}。」）。
 *    所以是「没什么力气」而不是「乏」——「困得厉害，乏。」读不通（2026-11-26 修）。
 */
function energyWord(energy) {
  const v = Number(energy);
  if (!Number.isFinite(v)) return '还好';
  if (v < 0.3) return '没什么力气';
  if (v < 0.5) return '有点累';
  if (v < 0.75) return '还行';
  return '精神不错';
}

/* ──────────────────────────────────────────────────────────────
 * 二、模板池（每类 ≥8 句；每句都带真实变量）
 * ────────────────────────────────────────────────────────────── */

/**
 * 模板是函数而不是字符串 —— 因为强烈建议**每句都用变量**，
 * 而字符串占位符替换在缺变量时会漏出 `{clock}` 这种半成品。
 * 函数缺变量会直接算出 `undefined点`，测试里一眼能看见。
 */
export const RENDER_POOLS = Object.freeze({
  /** 睡觉：夜间 / 精力低。不编造"梦见什么"。 */
  rest: [
    (v) => `才${v.hourCn}点，眼睛就睁不开了。`,
    (v) => `这个点该睡了，${v.clock}了。`,
    (v) => `有点乏，先眯一会儿，${v.hourText}了。`,
    (v) => `躺下了，手机屏幕还亮着，${v.clock}。`,
    (v) => `脑子转不动了，${v.clock}，去睡。`,
    (v) => `${v.dateCn}，撑不住了，${v.energyWord}。`,
    (v) => `被窝里暖和，到了${v.clock}还不想动。`,
    (v) => `${v.hourText}了，困劲儿一阵一阵地上来。`,
    (v) => `眼皮打架，${v.hourText}，真撑不住了。`,
    (v) => `${v.weekdayCn}就这样过去了，${v.clock}，先睡。`,
  ],

  /** 看时间：整点。真实时刻，最容易验证。 */
  check_time: [
    (v) => `看了下时间，${v.hourText}。`,
    (v) => `抬头看了眼钟，${v.hourText}。`,
    (v) => `哦，已经${v.hourText}了。`,
    (v) => `屏幕上显示${v.clock}，发了一会儿呆。`,
    (v) => `${v.dateCn}，${v.weekdayCn}，${v.clock}。`,
    (v) => `时间过得挺快，${v.hourText}，${v.dayProgress}。`,
    (v) => `${v.hourText}，${v.dayProgress}。`,
    (v) => `又到整点了，${v.clock}，${v.slot}。`,
    (v) => `瞄了一眼，${v.hourText}，手上还停着。`,
    (v) => `${v.fullDateCn} ${v.clock}，记了一下。`,
  ],

  /** 翻旧事：只在 hasHistory 时选。只提日期，不提具体事件。 */
  recall: [
    (v) => `翻了翻前几天的记录，${v.pastCn}那几行还在。`,
    (v) => `想起${v.pastCn}有点事，翻了翻，没翻到细节。`,
    (v) => `把${v.pastCn}那几笔又看了一遍。`,
    (v) => `翻旧东西，看到${v.pastCn}的一行字，愣了一会儿。`,
    (v) => `前几天的事有点模糊了，${v.pastCn}那会儿还清楚。`,
    (v) => `翻了翻从前存下的东西，${v.pastCn}之后的没怎么动过。`,
    (v) => `翻到${v.pastCn}的一条，看了一会儿才想起来是什么。`,
    (v) => `存着的越来越多，${v.pastCn}的还没理完。`,
    (v) => `回头翻了翻，${v.yesterdayCn}记的东西现在看有点陌生。`,
    (v) => `${v.clock}，翻着旧记录，${v.pastCn}那天的还在最上面。`,
  ],

  /**
   * 发呆：默认项。把真实情绪值转一句话，不说"为什么"。
   *
   * ⚠️ 每句都套 moodWord 的**四种搭配**都验过（2026-11-26）：
   *    「有点X」「X。」「心情X」「心里X」。
   *    所以句子只能用这四种句式，别写「X得很」之类会暴露词性的说法。
   */
  idle_think: [
    (v) => `${v.clock}，有点${v.moodWord}。`,
    (v) => `没什么事，${v.moodWord}，就这么待着。`,
    (v) => `${v.slot}，心情${v.moodWord}，说不上为什么。`,
    (v) => `发呆。${v.slot}很安静，${v.moodWord}。`,
    (v) => `${v.moodWord}。也说不上来在想什么。`,
    (v) => `坐在那儿，${v.moodWord}，${v.clock}。`,
    (v) => `${v.hourText}，心里${v.moodWord}，懒得动。`,
    (v) => `没什么声音，${v.moodWord}，这样也挺好。`,
    (v) => `${v.dateCn}这天，${v.moodWord}，别的没什么。`,
    (v) => `手撑着脸，${v.moodWord}，${v.slot}就这么过去。`,
  ],

  /** 整理：收拾自己的记录/收藏。不编造收拾了什么具体东西。 */
  organize: [
    (v) => `把最近记的东西理了理，${v.clock}。`,
    (v) => `整理了一下存着的东西，${v.dateCn}的还没归位。`,
    (v) => `把旧记录按日期排了排，理到${v.pastCn}那儿。`,
    (v) => `${v.hourText}，收拾了一下，顺手归了两笔。`,
    (v) => `把散着的记录归到一起，顺手又写了两行。`,
    (v) => `理东西理到一半，${v.clock}了。`,
    (v) => `${v.dateCn}，把这几天的记录翻出来理了理。`,
    (v) => `顺手整理了一下，从${v.clock}理到现在。`,
    (v) => `存的东西有点多，理了一会儿，${v.hourText}。`,
    (v) => `${v.weekdayCn}，把存的记录按日子叠了一下。`,
  ],
});

/* ──────────────────────────────────────────────────────────────
 * 三、随机源
 * ────────────────────────────────────────────────────────────── */

/**
 * 字符串 → 32 位种子（FNV-1a）。
 *
 * 为什么不用 Math.random 做确定性渲染：测试要「同 seed 同输出」，
 * 必须是一个可复算的 PRNG，而不是全局随机状态。
 *
 * @param {string|number} seed
 * @returns {number}
 */
function hashSeed(seed) {
  const s = String(seed ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * mulberry32：32 位状态、单次乘法，够用且完全确定。
 *
 * @param {number} a 种子
 * @returns {() => number} 返回 [0,1)
 */
function mulberry32(a) {
  let t = a >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 非确定随机源（生产用）。
 *
 * ⚠️ 只用 Math.random 取**下标**：不做任何需要均匀性的统计，
 *    退化成"总选第一句"也不影响正确性，只影响观感。
 */
const randomSource = () => Math.random();

/* ──────────────────────────────────────────────────────────────
 * 四、渲染
 * ────────────────────────────────────────────────────────────── */

/**
 * 抹掉 32 位以上 hex（openid 形状）。
 *
 * 模板本身不拼 id，这里是一道**兜底闸门**：
 * 生活日志常被关系/群史模块拿去二次拼装，漏一次就是隐私泄露（红线 2）。
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubId(text) {
  return String(text ?? '').replace(/[0-9a-fA-F]{32,}/g, '');
}

/**
 * 从池里挑一句并渲染。内部实现，两种入口共用。
 *
 * @param {string} kind
 * @param {object} state
 * @param {number|string|Date} now
 * @param {() => number} rng
 * @returns {string}
 */
function renderWith(kind, state, now, rng) {
  const pool = RENDER_POOLS[kind] || RENDER_POOLS.idle_think;
  const vars = makeVars(state, now);

  let idx = 0;
  try {
    const r = Number(rng());
    idx = Number.isFinite(r) ? Math.floor(r * pool.length) : 0;
  } catch {
    idx = 0;
  }
  if (idx < 0 || idx >= pool.length) idx = 0;

  let text = '';
  try {
    text = String(pool[idx](vars) ?? '');
  } catch {
    text = '';
  }

  // 模板算不出东西时不返回空串（空串进日志等于「静默失败」），
  // 退回一句纯变量拼装，至少有真实时间可读。
  if (!text.trim()) text = `${vars.clock}，${vars.moodWord}。`;

  return scrubId(text).trim();
}

/**
 * 渲染一句生活流（随机模板）。
 *
 * `kind` 不认识时回落 `idle_think` 而不是返回空串 ——
 * 空串会安静地写进日志，正是本项目最怕的失败形态（开发规则 §16.4）。
 *
 * @param {'rest'|'check_time'|'recall'|'idle_think'|'organize'|string} kind
 * @param {{mood?:{energy?:number,mood?:number}, hasHistory?:boolean}} state
 * @param {number|string|Date} now
 * @returns {string}
 */
export function renderActivity(kind, state, now) {
  return renderWith(kind, state, now, randomSource);
}

/**
 * 同 renderActivity，但同 seed 必然同输出（测试用）。
 *
 * seed 可以给字符串（例如 `<gid>|<hour>`），这样「同一群同一小时」
 * 在重跑时能复现同一条 —— 排查复读机问题时非常省事。
 *
 * @param {string} kind
 * @param {object} state
 * @param {number|string|Date} now
 * @param {string|number} seed
 * @returns {string}
 */
export function renderActivityDeterministic(kind, state, now, seed) {
  return renderWith(kind, state, now, mulberry32(hashSeed(seed)));
}

/** 每个模板池的句子数（回归测试用，防有人手滑删到 8 句以下）。 */
export function poolSizes() {
  const out = {};
  for (const [k, pool] of Object.entries(RENDER_POOLS)) out[k] = pool.length;
  return out;
}

/**
 * 导出变量构造器：测试要断言「模板用到的变量都真实」，
 * 生产侧也可能想拿时段词拼别的话（如心跳引用的前缀）。
 *
 * @param {object} state
 * @param {number|string|Date} now
 * @returns {object}
 */
export { makeVars };

export default {
  RENDER_POOLS,
  renderActivity,
  renderActivityDeterministic,
  scrubId,
  poolSizes,
  makeVars,
};
