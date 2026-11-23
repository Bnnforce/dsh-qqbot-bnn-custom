/**
 * game-core — 群内玩法的纯逻辑层（猜拳 / 骰子 / 抽签）
 *
 * ── 为什么单独抽一层 ─────────────────────────────────────────────────────────
 * 三个命令的 handler 都应该只有「取参数 → 调这里 → 返回文本」十行代码；
 * 真正会出错的东西（规则判定、表达式解析、随机、文案选择）全在这个文件里。
 * 这样：
 *   · 纯函数 = 可直接单测（`维护/测试/mock-game-core.mjs`），不需要伪造 ctx；
 *   · 三个命令共享同一套随机/格式化，不会各写一份、各自出 bug。
 *
 * ── 纪律（`开发规则`）────────────────────────────────────────────────────────
 *   · **禁止 eval / new Function**：骰子表达式手写正则解析，解析失败回默认。
 *     `/骰子 1d6; rm -rf /` 这类输入必须只被当成无效参数，绝不能被执行。
 *   · 随机源由调用方注入（`rng`），便于测试确定性；
 *   · 无 IO、无 Date.now()（`now` 入参）、无全局状态；
 *   · 所有阈值来自 `CONFIG`（由 game-config.json 覆盖），不散落魔法数字。
 */

// ══════════════════════════════ 配置 ══════════════════════════════

/** 默认配置（首次运行写入 `{dataRoot}/.qqbot-extensions/data/game-config.json`）。 */
export const DEFAULT_CONFIG = {
  /** 骰子：最多几个骰子（防 `/骰子 999d6` 刷屏）。 */
  maxDiceCount: 20,
  /** 骰子：最大面数（防 `1d99999` 超长输出）。 */
  maxDiceFaces: 1000,
  /** 骰子：修饰符绝对值上限。 */
  maxDiceModifier: 1000,
  /** 骰子：输出里最多列几个骰子明细（超过就只给总数）。 */
  maxDiceListed: 10,
  /** 冷却：同一人同一群两次命令的最小间隔（毫秒）。 */
  cooldownMs: 2000,
  /** 冷却状态最多记多少个 key（防内存无界增长）。 */
  cooldownMaxKeys: 5000,
};

/** 把外部配置收敛成合法值（越界夹住、类型不符回落默认，绝不抛）。 */
export function resolveConfig(raw) {
  const d = DEFAULT_CONFIG;
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    maxDiceCount: num(src.maxDiceCount, d.maxDiceCount, 1, 100),
    maxDiceFaces: num(src.maxDiceFaces, d.maxDiceFaces, 2, 100000),
    maxDiceModifier: num(src.maxDiceModifier, d.maxDiceModifier, 0, 100000),
    maxDiceListed: num(src.maxDiceListed, d.maxDiceListed, 1, 50),
    cooldownMs: num(src.cooldownMs, d.cooldownMs, 0, 60000),
    cooldownMaxKeys: num(src.cooldownMaxKeys, d.cooldownMaxKeys, 100, 100000),
  };
}

// ══════════════════════════════ 猜拳 ══════════════════════════════

/** 三个手势（顺序无关，判定用 beats 表）。 */
export const RPS_HANDS = ['石头', '剪刀', '布'];

/** 每个手势赢哪个（石头赢剪刀、剪刀赢布、布赢石头）。 */
const RPS_BEATS = { 石头: '剪刀', 剪刀: '布', 布: '石头' };

/**
 * 把用户输入归一成手势。
 *
 * 为什么要这么宽容：群友不会严格按格式打 —— 会打「✊」、会打「rock」、
 * 会打「拳头」、会打「石頭」（繁体）。全都认，认不出才回引导。
 *
 * @returns 归一后的手势；无法识别 → 空串
 */
export function normalizeRps(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  const map = {
    石头: ['石头', '石頭', 'rock', 'r', '✊', '拳头', '拳', '锤子', '🔨'],
    剪刀: ['剪刀', 'scissors', 's', '✌️', '✌', '剪子', '剪刀手', '✂️', '✂'],
    布: ['布', 'paper', 'p', '🖐', '🖐️', '手掌', '五', '✋', '🤚'],
  };
  // ⚠️ 2026-11-09 修（测试抓到的真 bug）：
  //   初版写 `s.includes(a)` → "scissors" 里含 "s"（石头的别名）→ 被判成石头。
  //   改成两级：① 先做**全等**匹配（覆盖 r/s/p 这类缩写）；
  //             ② 再做**包含**匹配，但只允许长度 ≥2 的别名
  //                （单字符别名只参与全等，避免上面那种子串误命中）。
  for (const [hand, aliases] of Object.entries(map)) {
    if (aliases.some((a) => a === s)) return hand;
  }
  for (const [hand, aliases] of Object.entries(map)) {
    if (aliases.some((a) => a.length >= 2 && s.includes(a))) return hand;
  }
  return '';
}

/**
 * 判定胜负。
 * @returns `'win'`（她赢）/ `'lose'`（她输）/ `'tie'`
 */
export function judgeRps(mine, theirs) {
  if (mine === theirs) return 'tie';
  return RPS_BEATS[mine] === theirs ? 'win' : 'lose';
}

/**
 * 文案池 —— **这是"她有性格"的唯一来源**。
 *
 * 设计取向（对齐爱莉希雅人设：温柔俏皮、爱反问、会害羞但也会小得意）：
 *   · 赢：小得意但不刻薄，不用「菜」「弱」这类贬人词
 *   · 输：不服气但不撒泼，用「再来」而不是「你作弊」
 *   · 平：调侃式带过
 * 每档多条随机，避免连着玩看到同一句。
 */
const RPS_TEXTS = {
  win: [
    '嘿嘿，我赢啦～',
    '这回是我运气好～',
    '赢你了，开心一下。',
    '嗯哼，下次该你赢了吧？',
  ],
  lose: [
    '诶——输了，再来一次？',
    '这局算你的，别得意哦。',
    '唔，我记住了，下次不会让。',
    '差一点！再来再来。',
  ],
  tie: [
    '平了，心有灵犀？',
    '一样的，那我们再试一次？',
    '哈，想到一块去了。',
  ],
};

/**
 * 玩一局猜拳（**单轮直判，不走卡片**）。
 *
 * ⚠️ 2026-11-09 现状：`/猜拳` 已改为 botplay 卡片（盲出），**线上不再调用本函数**。
 *    保留它的理由：① 它是 `judgeRps` + 文案池的**参考实现**，单测靠它验证文案质量；
 *    ② 万一以后要做「纯文本降级路径」（卡片发不出去时），可以直接用。
 *
 * 🔴 但**不要**把它接到卡片流程里 —— 它会先说出自己出什么（`我出${mine}`），
 *    那正是本次要修的缺陷。卡片流程用 `rpsWaitingText` / `rpsRevealText`。
 *
 * @param raw  用户输入的手势（可能为空 = 随机）
 * @param rng  随机源（默认 Math.random；测试注入固定值）
 * @returns 回话文本
 */
export function playRps(raw, rng = Math.random) {
  const theirs = normalizeRps(raw);
  const mine = RPS_HANDS[Math.floor(rng() * RPS_HANDS.length)] ?? '石头';

  if (!theirs) {
    // 没给手势（或给了看不懂的）→ 先出一次，并引导下次怎么玩
    const tips = raw && String(raw).trim()
      ? `「${String(raw).trim().slice(0, 10)}」是啥手势呀？`
      : '';
    return `${tips}${tips ? '' : ''}我出${mine}。你出石头、剪刀还是布？`.trim();
  }

  const verdict = judgeRps(mine, theirs);
  const pool = RPS_TEXTS[verdict] ?? RPS_TEXTS.tie;
  const tail = pool[Math.floor(rng() * pool.length)] ?? '';

  if (verdict === 'tie') return `你也出${theirs}？${tail}`;
  const head = verdict === 'win'
    ? `你出${theirs}，我出${mine}。`
    : `你出${theirs}，我出${mine}。`;
  return `${head}${tail}`;
}

// ══════════════════ 猜拳 · 盲出（botplay 卡片版，2026-11-09 新增）══════════════════

/**
 * 盲出手势 —— 卡片发出时定一次，**卡片正文绝不显示**，只在点击结算时揭示。
 *
 * 为什么必须盲：初版 `/猜拳` 直接输出「我出石头。你出石头、剪刀还是布？」——
 * 对方照着克制出就必胜，游戏等于没有。这是设计缺陷，不是文案问题。
 */
export function pickBlindHand(rng = Math.random) {
  const i = Math.floor(rng() * RPS_HANDS.length);
  return RPS_HANDS[i] ?? '石头';
}

/** 卡片按钮 id → 手势（单点定义，避免命令/事件两处各写一份）。 */
export const RPS_BUTTON_HAND = {
  rock: '石头',
  scissors: '剪刀',
  paper: '布',
};

/**
 * 拼卡片的「等待出拳」正文（**绝不含她的手**）。
 *
 * 🔴 本功能的核心纪律：这段文本里不能出现她出的手势，否则游戏失去意义。
 *    测试有负向断言守着（T11）。
 */
export function rpsWaitingText() {
  return [
    '## ✊✌️🖐 猜拳',
    '',
    '我先出好了，但不会告诉你 —— 你出吧。',
    '',
    '> 点下面的按钮出拳，出完才揭晓。',
  ].join('\n');
}

/** 等待出拳时的按钮（一行三个）。 */
export function rpsHandButtons() {
  return [
    { id: 'rock', label: '✊ 石头', botAction: { type: 'reply_text', text: '' } },
    { id: 'scissors', label: '✌️ 剪刀', botAction: { type: 'reply_text', text: '' } },
    { id: 'paper', label: '🖐 布', botAction: { type: 'reply_text', text: '' } },
  ];
}

/** 结算后的按钮。 */
export function rpsAgainButtons() {
  return [{ id: 'again', label: '🔄 再来一局', botAction: { type: 'reply_text', text: '' } }];
}

/**
 * 结算：给定「她盲出的手」与「对方点的手」，产出**揭示**文本。
 *
 * 注意顺序：这里是**唯一**允许说出她手势的地方。
 *
 * @param blindHand 她这一局出的（从服务端状态读，卡片上从未出现）
 * @param userHand  对方点的
 * @param rng       随机源（选文案）
 */
export function rpsRevealText(blindHand, userHand, rng = Math.random) {
  const mine = RPS_HANDS.includes(blindHand) ? blindHand : '石头';
  const theirs = RPS_HANDS.includes(userHand) ? userHand : '';
  if (!theirs) return rpsWaitingText();

  const verdict = judgeRps(mine, theirs);
  const pool = RPS_TEXTS[verdict] ?? RPS_TEXTS.tie;
  const tail = pool[Math.floor(rng() * pool.length)] ?? '';
  const head = `你出 ${theirs}，我出 ${mine}。`;
  const body = verdict === 'tie' ? `平了，${tail.replace(/^平了，?/, '')}` : tail;
  return ['## ✊✌️🖐 猜拳', '', head + body, '', '> 点「再来一局」重新来过。'].join('\n');
}

// ══════════════════════════════ 骰子 ══════════════════════════════

/**
 * 解析骰子表达式（**手写正则，绝不 eval**）。
 *
 * 支持：`d20` / `1d6` / `2d6` / `3d10+2` / `2d8-1`
 * 不支持（一律当无效，回默认 1d6）：`2*3d6`、`(1d6)+1`、`1d6; rm -rf /`
 *
 * @returns `{ count, faces, modifier }`；无效 → `null`
 */
export function parseDiceExpr(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!s) return null;
  // 严格全串匹配：可选个数(0-2位) + d/D + 面数(1-4位) + 可选修饰符
  const m = /^(\d{0,2})[dD](\d{1,4})([+-]\d{1,4})?$/.exec(s);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const faces = Number(m[2]);
  const modifier = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(count) || count < 1) return null;
  if (!Number.isFinite(faces) || faces < 1) return null;
  if (!Number.isFinite(modifier)) return null;
  return { count, faces, modifier };
}

/**
 * 掷骰子。
 *
 * @param raw 表达式字符串（空 = 默认 1d6）
 * @param cfg 已收敛的配置
 * @param rng 随机源
 * @returns 回话文本
 */
export function rollDice(raw, cfg = DEFAULT_CONFIG, rng = Math.random) {
  const c = cfg ?? DEFAULT_CONFIG;
  const expr = String(raw ?? '').trim();
  const parsed = expr ? parseDiceExpr(expr) : { count: 1, faces: 6, modifier: 0 };

  if (expr && !parsed) {
    return `「${expr.slice(0, 20)}」这个骰子表达式没看懂。可以这样写：/骰子 2d6 或 /骰子 d20`;
  }

  const count = Math.min(c.maxDiceCount, parsed.count);
  const faces = Math.min(c.maxDiceFaces, parsed.faces);
  const modifier = Math.max(-c.maxDiceModifier, Math.min(c.maxDiceModifier, parsed.modifier));

  const rolls = [];
  for (let i = 0; i < count; i += 1) {
    rolls.push(Math.floor(rng() * faces) + 1);
  }
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + modifier;

  // 表达式标签：用户给了就回显（但用夹住后的值，避免回显一个没被执行的值）
  const label = `${count}d${faces}${modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : ''}`;

  // 明细：只列前 maxDiceListed 个，防超长刷屏
  const listed = rolls.slice(0, c.maxDiceListed);
  const detail = listed.join(' + ')
    + (modifier > 0 ? ` + ${modifier}` : modifier < 0 ? ` - ${Math.abs(modifier)}` : '')
    + (rolls.length > listed.length ? ` + …（还有 ${rolls.length - listed.length} 个）` : '');

  // 单骰的满值/最小提示（只在 1 个骰子时给，多了没意义）
  let flavor = '';
  if (count === 1) {
    if (rolls[0] === faces) flavor = ' 满值！';
    else if (rolls[0] === 1) flavor = ' …最小的。';
  }

  if (count === 1 && modifier === 0) {
    return `🎲 ${label} = ${total}${flavor}`;
  }
  return `🎲 ${label} = ${detail} = ${total}${flavor}`;
}

/**
 * 掷骰子（**结构化**版本，供 botplay 卡片用）。
 *
 * 与 `rollDice` 的区别：那个返回纯文本（给斜杠命令降级用），
 * 这个返回 `{ label, rolls, modifier, total, flavor, expr }`，由 `diceCardText` 拼卡片。
 *
 * @returns 结构体；表达式非法 → `{ invalid: true, expr }`
 */
export function rollDiceData(raw, cfg = DEFAULT_CONFIG, rng = Math.random) {
  const c = cfg ?? DEFAULT_CONFIG;
  const expr = String(raw ?? '').trim();
  const parsed = expr ? parseDiceExpr(expr) : { count: 1, faces: 6, modifier: 0 };
  if (expr && !parsed) return { invalid: true, expr };

  const count = Math.min(c.maxDiceCount, parsed.count);
  const faces = Math.min(c.maxDiceFaces, parsed.faces);
  const modifier = Math.max(-c.maxDiceModifier, Math.min(c.maxDiceModifier, parsed.modifier));

  const rolls = [];
  for (let i = 0; i < count; i += 1) rolls.push(Math.floor(rng() * faces) + 1);
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + modifier;
  const label = `${count}d${faces}${modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : ''}`;

  let flavor = '';
  if (count === 1) {
    if (rolls[0] === faces) flavor = '满值！';
    else if (rolls[0] === 1) flavor = '最小的。';
  }
  return { label, rolls, modifier, total, flavor, expr: label, invalid: false };
}

/**
 * 拼骰子卡片正文（主人 2026-11-09 要求：显示「投到多少点」）。
 */
export function diceCardText(data) {
  const d = data && typeof data === 'object' ? data : {};
  if (d.invalid) {
    return [
      '## 🎲 骰子',
      '',
      `「${String(d.expr ?? '').slice(0, 20)}」这个写法没看懂。`,
      '',
      '> 可以这样写：`/骰子 2d6`、`/骰子 d20`、`/骰子 3d10+2`',
    ].join('\n');
  }
  const rolls = Array.isArray(d.rolls) ? d.rolls : [];
  const lines = ['## 🎲 骰子', ''];
  // 单骰：直接给点数；多骰：给各点 + 合计
  if (rolls.length === 1 && !d.modifier) {
    lines.push(`**${d.total} 点**${d.flavor ? `　${d.flavor}` : ''}`);
  } else {
    const detail = rolls.join(' + ')
      + (d.modifier > 0 ? ` + ${d.modifier}` : d.modifier < 0 ? ` - ${Math.abs(d.modifier)}` : '');
    lines.push(`\`${d.label}\` = ${detail} = **${d.total}**${d.flavor ? `　${d.flavor}` : ''}`);
  }
  lines.push('', '> 点「再来一次」重新掷。');
  return lines.join('\n');
}

/**
 * 骰子卡片的按钮：再来一次。
 *
 * ⚠️ 2026-11-09（加功能按钮时）：原来用 🎲，而卡片底部现在有「🎲 骰子」功能按钮，
 *   一张卡上两个 🎲 会让人点错。主操作改用 🔁（"再来一次"的语义本就是这个）。
 */
export function diceAgainButtons() {
  return [{ id: 'again', label: '🔁 再来一次', botAction: { type: 'reply_text', text: '' } }];
}

// ══════════════════════════════ 抽签 ══════════════════════════════

/**
 * 签等（2026-11-09 第三轮：主人要求「吉凶分层更细 + 1-10 分」）。
 *
 * 七档，从大吉到凶，每档有**分数区间（1-10）**：
 *   大吉 9-10 / 中吉 8 / 小吉 7 / 末吉 6 / 平 5 / 小凶 3-4 / 凶 1-2
 *
 * ⚠️ 演进史（如实记录，别再反复改）：
 *   第一轮：主人说「不做凶档」→ 只有吉。
 *   第二轮：主人说「先说吉还是凶」→ 加四档，仍不含凶。
 *   第三轮（本次）：主人说「吉凶分多点层给个分数 1-10」→ **正式加入凶档**。
 *   既然现在有了 1-10 分，凶档就是"今天运气 2 分"这种**量化表达**，
 *   而不是诅咒式断言 —— 配上金句签文（都是积极/温和的），整体仍是"图个乐"。
 *
 * 权重设计（倾向好运，但不回避低分）：
 *   大吉 1 / 中吉 3 / 小吉 5 / 末吉 6 / 平 5 / 小凶 3 / 凶 1
 *   → 吉档合计 15，平 5，凶档合计 4（约 17% 会抽到偏低的）
 */
export const FORTUNE_TIERS = [
  { key: 'great', label: '大吉', weight: 1, emoji: '🌟', min: 9, max: 10, tone: 'best' },
  { key: 'good', label: '中吉', weight: 3, emoji: '✨', min: 8, max: 8, tone: 'good' },
  { key: 'small', label: '小吉', weight: 5, emoji: '🍀', min: 7, max: 7, tone: 'good' },
  { key: 'last', label: '末吉', weight: 6, emoji: '🌱', min: 6, max: 6, tone: 'mild' },
  { key: 'plain', label: '平', weight: 5, emoji: '☁️', min: 5, max: 5, tone: 'mild' },
  { key: 'minor', label: '小凶', weight: 3, emoji: '🌧️', min: 3, max: 4, tone: 'low' },
  { key: 'bad', label: '凶', weight: 1, emoji: '⛈️', min: 1, max: 2, tone: 'low' },
];

/** 兼容：只要「吉」档的旧接口（外部若还按 key 取）。 */
export const FORTUNE_TIERS_LUCKY_ONLY = FORTUNE_TIERS.filter((t) => t.min >= 6);

/**
 * 签文来源：**外部金句库优先**（`人格/每日金句.txt`，300+ 条），读不到回退内置。
 *
 * 为什么用金句当签文（主人 2026-11-09 第三轮要求）：
 *   「金句库给抽签用」—— 原来的今日金句功能被移除，那批金句（都是积极、温和的）
 *   正好当签文：**不管抽到几分的签，配的话都是暖的**。
 *   这样即使抽到「凶」，读到的也是「慢一点也没关系」，不会真让人难受。
 */
const BUILTIN_LINES = [
  '慢一点也没关系，你又不赶着去成为别人。',
  '把今天过好，就已经赢过昨天的自己了。',
  '不必事事满分，及格也是一种活法。',
  '你不是懒，你只是电量需要充一会儿。',
  '能好好吃饭的人，运气一般不会太差。',
  '先照顾好自己的心情，再去照顾世界。',
  '有些事做不成，是老天在帮你省力气。',
  '别急，属于你的会在你准备好的时候来。',
  '允许自己普通，也允许自己闪闪发光。',
  '今天也要记得，你不是一个人在扛。',
  '休息不是偷懒，是为了走更远的路。',
  '你不需要向任何人证明你值得被喜欢。',
  '走慢一点，风景才看得清。',
  '遇到难过的事，先睡一觉，明天再想。',
  '好好吃饭、好好睡觉，是最低成本的转运。',
  '不是所有努力都要立刻有回声。',
  '世界很吵，记得听听自己的声音。',
  '别把别人的标准，当成自己的尺子。',
  '今天的你，已经比昨天更厉害一点了。',
  '遇到烂人烂事，绕开就是赢。',
  '想做的事现在就做，想见的人现在就见。',
  '生活不是考试，没有标准答案。',
];

/**
 * 加载签文库。
 *
 * @param deps.root  可选，数据根（`{root}/人格/每日金句.txt`）
 * @param deps.readFile  可选，读文件函数（测试注入，避免真读盘）
 * @returns 非空数组；任何失败都回退内置
 */
export function loadFortuneLines(deps) {
  try {
    const root = String(deps?.root ?? '').trim();
    if (!root) return BUILTIN_LINES.slice();
    const join = deps?.join;
    const readFile = deps?.readFile;
    if (typeof join !== 'function' || typeof readFile !== 'function') return BUILTIN_LINES.slice();
    const raw = readFile(join(root, '人格', '每日金句.txt'), 'utf8');
    const list = String(raw ?? '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith('#') && !x.startsWith('//'));
    return list.length > 0 ? list : BUILTIN_LINES.slice();
  } catch {
    return BUILTIN_LINES.slice();
  }
}

/** 兼容旧接口：全部签文（内置那份，测试/诊断用）。 */
export const FORTUNE_LINES = BUILTIN_LINES.slice();

/**
 * 按权重抽一个签等（可注入 rng）。
 * @returns 签等对象（永远合法）
 */
export function pickFortuneTier(rng = Math.random) {
  const total = FORTUNE_TIERS.reduce((s, t) => s + t.weight, 0);
  let r = rng() * total;
  for (const t of FORTUNE_TIERS) {
    r -= t.weight;
    if (r < 0) return t;
  }
  return FORTUNE_TIERS[FORTUNE_TIERS.length - 1];
}

/** 在签等区间内取一个分数（1-10）。 */
export function pickFortuneScore(tier, rng = Math.random) {
  const t = tier && typeof tier === 'object' ? tier : FORTUNE_TIERS[4];
  const min = Math.max(1, Math.floor(Number(t.min) || 1));
  const max = Math.min(10, Math.floor(Number(t.max) || min));
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/** 分数 → 星级（满分 5 星，按 10 分制换算）。 */
export function scoreStars(score) {
  const s = Math.max(0, Math.min(10, Math.floor(Number(score) || 0)));
  return Math.max(1, Math.round(s / 2));
}

/**
 * 抽一签（**每天固定一种** —— 2026-11-09 第四轮，主人要求）。
 *
 * 为什么改成按天固定：
 *   主人说「一天一种签，不用多种」。原来每次点都重抽，同一个人能反复抽到好签，
 *   签的意义就没了。现在**同一天同一个人永远是同一签**，第二天才换。
 *
 * 怎么做到「稳定」：
 *   · **不用 `Math.random`**（那每次都变）；用「日期 + 身份」做确定性散列当随机种子；
 *   · 种子输入：`日期键 | 用户身份 | 分组盐` —— 同一天同一人 → 同一种子 → 同一结果；
 *   · 跨天自动变（日期键变了）。
 *
 * 与旧行为的兼容：
 *   · 仍支持注入 `rng` 覆盖（测试/诊断用）；
 *   · 不传 `seed` 时退回旧行为（每次随机）—— 但**线上调用必须传 seed**。
 *
 * @param opts.seed   种子串（**线上必须给**：`YYYY-MM-DD|uid`）
 * @param opts.rng    可选，显式随机源（给了就忽略 seed，测试专用）
 * @param opts.lines  签文库
 * @returns `{ tier, score, line, seed, dateKey }`
 */
export function drawFortune(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const lines = Array.isArray(o.lines) && o.lines.length ? o.lines : BUILTIN_LINES;
  const seed = String(o.seed ?? '').trim();

  // 有显式 rng → 用它（测试）；否则用 seed 派生确定性随机源
  const rng = typeof o.rng === 'function'
    ? o.rng
    : (seed ? seededRng(seed) : Math.random);

  const tier = pickFortuneTier(rng);
  const score = pickFortuneScore(tier, rng);
  const i = Math.floor(rng() * lines.length);
  const line = lines[i] ?? lines[0];

  return { tier, score, line, seed, dateKey: seed ? seed.split('|')[0] : '' };
}

/**
 * 由种子串派生**确定性**随机源（同一 seed 永远产生同一序列）。
 *
 * 算法：FNV-1a 32 位散列 → mulberry32 伪随机。
 * 选它的理由：无依赖、分布够均匀、状态只有 32 位、可复现 —— 抽签不需要密码学强度。
 *
 * @returns `() => number`（每次调用返回 [0,1) 的下一个值）
 */
export function seededRng(seed) {
  const s = String(seed ?? '');
  // FNV-1a
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  // mulberry32
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 日期键（`YYYY-MM-DD`，按 +08:00 算 —— 不能用宿主时区，Android 可能是别的）。
 *
 * @param now 毫秒时间戳（默认 Date.now()）
 */
export function fortuneDateKey(now) {
  const ms = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const t = new Date(ms + 8 * 3600_000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 拼抽签卡片正文（**先吉凶+分数，再给签文**）。
 *
 * 格式：
 * ```
 * ## 🌟 今日签 · 大吉
 *
 * **运气 9/10**　★★★★★
 *
 * 慢一点也没关系，你又不赶着去成为别人。
 *
 * > 抽签图个乐，别当真。
 * ```
 */
export function fortuneCardText(drawn) {
  const d = drawn && typeof drawn === 'object' ? drawn : drawFortune();
  const t = d.tier ?? FORTUNE_TIERS[4];
  const score = Math.max(1, Math.min(10, Math.floor(Number(d.score) || pickFortuneScore(t))));
  const stars = '★'.repeat(scoreStars(score)) + '☆'.repeat(5 - scoreStars(score));
  return [
    `## ${t.emoji} 今日签 · ${t.label}`,
    '',
    `**运气 ${score}/10**　${stars}`,
    '',
    String(d.line ?? ''),
    '',
    '> 抽签图个乐，别当真。',
  ].join('\n');
}

/**
 * 抽签卡片的按钮。
 *
 * ⚠️ 2026-11-09 第四轮：抽签改成**一天一种**后，「再抽一签」已经没有意义
 *   （同一天点多少次都是同一签）。
 *   与其留着一个点了没变化的按钮让人以为坏了，改成「🎴 今日签」—— 语义变成
 *   「再看一眼我今天的签」，点它只是刷新卡片。
 *
 * ⚠️ 2026-11-09 第五轮（加功能按钮时发现）：文案原来用 **📅（日历 emoji）**，
 *   而现在卡片底部同时有「📅 日历」功能按钮 —— **同一张卡上两个 📅**，
 *   群里点错就是"想看日历结果刷了签"。改成 🎴（与本卡主题一致，与日历区分开）。
 *   骰子那边同理：「🎲 再来一次」撞「🎲 骰子」→ 改成 🔁。
 *
 * 如果主人以后要回到「可反复抽」，只需把 label/id 改回 again 并让 draw 不传 seed。
 */
export function fortuneAgainButtons() {
  return [{ id: 'again', label: '🎴 今日签', botAction: { type: 'reply_text', text: '' } }];
}

// ══════════════════════════════ 冷却 ══════════════════════════════

/**
 * 冷却器（进程内，不落盘）。
 *
 * 为什么存内存不落盘：
 *   · 冷却只是防刷，重启后清零**没有副作用**（不像计费/状态需要持久）；
 *   · 零 IO = 零磁盘压力，与 `recent-media.mjs` 的做法一致。
 *
 * 为什么需要它：命令**不走模型**，没有天然成本限制 —— 有人能一秒刷 100 次。
 *
 * @returns `{ check(key, now) => { ok, retryAfterMs } }`
 */
export function createCooldown(cfg = DEFAULT_CONFIG) {
  const c = cfg ?? DEFAULT_CONFIG;
  const last = new Map();

  return {
    /**
     * 检查并占用一次。
     * @param key 通常是 `${gid}:${uid}`
     * @param now 当前时间（ms）
     * @returns `{ ok: true }` 放行；`{ ok: false, retryAfterMs }` 拒绝
     */
    check(key, now) {
      const k = String(key ?? '');
      const t = Number(now);
      const ms = Math.max(0, Number(c.cooldownMs) || 0);
      if (!k || !Number.isFinite(t)) return { ok: true };
      if (ms <= 0) return { ok: true };

      const prev = last.get(k);
      if (typeof prev === 'number' && t - prev < ms) {
        return { ok: false, retryAfterMs: ms - (t - prev) };
      }

      // 上限保护：超了清一半（Map 迭代序 = 插入序，够用）
      const cap = Math.max(1, Number(c.cooldownMaxKeys) || 5000);
      if (last.size >= cap && !last.has(k)) {
        let drop = Math.ceil(cap / 2);
        for (const kk of last.keys()) {
          if (drop-- <= 0) break;
          last.delete(kk);
        }
      }
      last.set(k, t);
      return { ok: true };
    },

    /** 清空（测试用 / 热重载时）。 */
    clear() { last.clear(); },

    /** 当前记录数（诊断用）。 */
    size() { return last.size; },
  };
}

/** 冷却拒绝时的统一回话（不报错、不禁言，只是提醒）。 */
export function cooldownText(retryAfterMs) {
  const ms = Math.max(0, Number(retryAfterMs) || 0);
  const sec = Math.max(1, Math.ceil(ms / 1000));
  return `别急呀，${sec} 秒后再来～`;
}
