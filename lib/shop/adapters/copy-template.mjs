/**
 * shop/adapters/copy-template — 文案生成（模板 + 可选 LLM 润色）（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 契约（CopyProvider）：
 *   generate({kind, state, persona, meta, cfg, llm}) → Promise<string>
 *
 * kind：
 *   'open'    开店（每天一次）
 *   'close'   打烊（每天一次）
 *   'event'   随机事件（稀有）
 *
 * 设计原则（写死在模板选择里）：
 *   ① **具体 > 抽象**：不写"今天生意一般"，写"进的草莓有点酸"
 *   ② **有细节 > 有情绪**：不写"我有点累"，写"奶油打过了"
 *   ③ **不解释 > 解释**：不说"因为下雨所以人少"
 *   ④ **避免重复**：排除最近用过的模板
 *
 * LLM 是**可选增强**：拿不到 llm 或润色失败 → 用模板原文（保证永远有话说）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 文案模板池（按 locale 分；公开可用版至少要两种语言）。 */
export const TEMPLATES = {
  'zh-CN': {
    open: [
      '开门了。今天进的货还行。',
      '开门。{item}备好了。',
      '开门了。{item}还剩{left}份。',
      '今天起得早，门先开了。',
      '开门。{item}用的是新货。',
      '开门了。今天想试个新的。',
    ],
    close: [
      '打烊了。今天卖了{sold}份。',
      '关门。今天没什么人。',
      '打烊。{topItem}卖得最好。',
      '今天卖了{sold}份，收了{revenue}。',
      '打烊了。明天{nextItem}多做点。',
      '关门。今天还行。',
    ],
    // 她自己的生活（定位：不是等客人的店）
    self: [
      '今天自己煮了一壶。',
      '试做了个新的，自己吃了。',
      '给自己留了份{item}。',
      '没什么人，自己也吃点。',
    ],
    // 虚构客人
    fictive: [
      '隔壁来订了两份{item}。',
      '有人托我做点{item}。',
      '外面有人问能不能送到隔壁。',
    ],
    event: {
      bigOrder: ['今天有人一口气订了{qty}份。', '来了个大单，{qty}份{item}。'],
      loss: ['进的货坏了。……算了，明天再进。', '今天亏了点。'],
      regular: ['那个总买{item}的又来了。', '{name}又来了。'],
      failedNew: ['试了个新口味。……不太行，不卖了。', '今天试的新东西不太行。'],
      busy: ['今天人多，差点没忙过来。', '忙了一天。'],
      praised: ['今天有人说我们家东西好吃。', '被夸了。'],
    },
  },
  'en-US': {
    open: [
      'Open for the day.',
      'Doors open. {item} is ready.',
      'Open. {left} portions of {item} left.',
    ],
    close: [
      'Closing up. Sold {sold} today.',
      'Shut for the night.',
      'Closed. {topItem} sold best.',
    ],
    self: ['Made a pot for myself today.', 'Tried something new and ate it myself.'],
    fictive: ['Someone next door ordered two {item}.'],
    event: {
      bigOrder: ['A big order today — {qty} portions.'],
      loss: ['Some stock went bad. Oh well.'],
      regular: ['The one who always buys {item} came by again.'],
      failedNew: ['Tried something new. Not good. Off the menu.'],
      busy: ['Busy day. Almost could not keep up.'],
      praised: ['Someone said our food is good today.'],
    },
  },
};

/** 取当前 locale 的模板（找不到回退到 zh-CN）。 */
export function templatesFor(locale) {
  return TEMPLATES[locale] || TEMPLATES['zh-CN'];
}

/**
 * 填模板占位符。
 * @param {string} tpl
 * @param {object} vars
 */
export function fillTemplate(tpl, vars = {}) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * 从候选里挑一个「最近没用过」的模板。
 *
 * @param {string[]} pool 模板池
 * @param {string[]} recent 最近用过的模板原文（避免重复）
 * @param {() => number} random
 */
export function pickTemplate(pool, recent = [], random = Math.random) {
  if (!Array.isArray(pool) || pool.length === 0) return '';
  const used = new Set((recent || []).map(String));
  const fresh = pool.filter((t) => !used.has(t));
  const src = fresh.length > 0 ? fresh : pool;
  return src[Math.floor(random() * src.length)];
}

/** 从状态里挑一个"今天的商品"用于文案。 */
function pickItem(state, random) {
  const names = Object.keys(state?.dailyStock || {});
  if (names.length === 0) return '';
  return names[Math.floor(random() * names.length)];
}

/** 取今日销量最高的商品。 */
function topItemOf(state) {
  const sold = state?.soldItems || {};
  let best = '', n = -1;
  for (const [k, v] of Object.entries(sold)) {
    if (Number(v) > n) { best = k; n = Number(v); }
  }
  if (best) return best;
  const names = Object.keys(state?.dailyStock || {});
  return names[0] || '';
}

/**
 * 生成文案（不含 LLM）。
 *
 * @param {{kind:string, state:object, persona:string, meta?:object, cfg:object, random?:()=>number, recent?:string[]}} p
 * @returns {string}
 */
export function generateFromTemplate(p) {
  const cfg = p.cfg || {};
  const random = typeof p.random === 'function' ? p.random : Math.random;
  const T = templatesFor(cfg.locale || 'zh-CN');
  const state = p.state || {};
  const meta = p.meta || {};
  const item = meta.item || pickItem(state, random);
  const stock = state.dailyStock || {};
  const left = stock[item]?.qty ?? 0;

  const vars = {
    item,
    left,
    sold: state.soldToday ?? 0,
    revenue: state.dailyRevenue ?? 0,
    topItem: topItemOf(state),
    nextItem: item,
    qty: meta.qty ?? 2,
    name: meta.name ?? '',
  };

  // 事件类
  if (p.kind === 'event') {
    const kind = meta.eventKind;
    const pool = T.event?.[kind];
    if (!pool || pool.length === 0) return '';
    return fillTemplate(pickTemplate(pool, p.recent, random), vars);
  }

  // 开店：可能插一句"她自己的生活"
  if (p.kind === 'open') {
    const base = fillTemplate(pickTemplate(T.open, p.recent, random), vars);
    const selfChance = Number(cfg.selfConsumptionChance) || 0;
    const fictiveChance = Number(cfg.fictionalCustomerChance) || 0;
    const roll = random();
    if (roll < selfChance && T.self?.length) {
      return `${base}${fillTemplate(pickTemplate(T.self, [], random), vars)}`;
    }
    if (roll < selfChance + fictiveChance && T.fictive?.length) {
      return `${base}${fillTemplate(pickTemplate(T.fictive, [], random), vars)}`;
    }
    return base;
  }

  // 打烊
  if (p.kind === 'close') {
    const base = fillTemplate(pickTemplate(T.close, p.recent, random), vars);
    const selfChance = Number(cfg.selfConsumptionChance) || 0;
    if (random() < selfChance && T.self?.length) {
      return `${base}${fillTemplate(pickTemplate(T.self, [], random), vars)}`;
    }
    return base;
  }

  return '';
}

/**
 * 用 LLM 润色（可选）。失败返回 null，调用方用模板原文。
 *
 * @param {{skeleton:string, persona:string, cfg:object, llm?:object, timeoutMs?:number}} p
 * @returns {Promise<string|null>}
 */
export async function polishWithLlm(p) {
  const llm = p.llm;
  if (!llm || typeof llm.polish !== 'function') return null;
  if (!p.skeleton) return null;
  try {
    const out = await llm.polish(p.skeleton, p.persona, { timeoutMs: p.timeoutMs });
    const s = String(out ?? '').trim();
    if (!s) return null;
    // 防跑偏：润色后长度不能暴涨（避免 LLM 写成小作文）
    if (s.length > p.skeleton.length * 2.5 + 40) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * 对外统一入口（模板 + 可选润色）。
 *
 * @returns {Promise<{text:string, source:'template'|'llm'}>}
 */
export async function generateCopy(p) {
  const skeleton = generateFromTemplate(p);
  if (!skeleton) return { text: '', source: 'template' };
  if (p.cfg?.useLlmPolish === false) return { text: skeleton, source: 'template' };
  const polished = await polishWithLlm({
    skeleton, persona: p.persona, cfg: p.cfg, llm: p.llm, timeoutMs: p.cfg?.llmTimeoutMs,
  });
  return polished ? { text: polished, source: 'llm' } : { text: skeleton, source: 'template' };
}