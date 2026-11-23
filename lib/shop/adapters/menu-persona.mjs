/**
 * shop/adapters/menu-persona — 从人格的人生清单生成菜单（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 契约（MenuProvider）：
 *   buildMenu({personaName, personaRoot, cfg, random}) → Promise<MenuItem[]>
 *
 * 三级降级（这是"公开可用"的关键）：
 *   ① 从 <personaRoot>/人生清单/<人格名>.md 的「吃喝」节提取
 *   ② 人格没有清单 → 用默认菜单池随机挑
 *   ③ 任何异常 → 静态兜底菜单（保证永远有货可卖）
 *
 * ⚠️ 硬编码红线：这里**不允许出现"比安安/爱莉希雅/GPT"**这类具体人格名。
 *    人格名一律由调用方传入。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config.mjs';

/** 商品名 → 参考价的启发式表（按"份量感"定，不需要精确成本）。 */
/**
 * 三档定价（2026-11-17 接入积分系统时改）。
 *
 * 定价依据：见 Bot/维护/积分方案-审查报告-20261117.md
 *   · 常见用户日产出 7.63 → 买基础档 8 净 −0.37（刚好花完）
 *   · 全勤用户日产出 14.29 → 买常规档 14 净 +0.29（平衡）
 * 分类逻辑贴人设：**现成的便宜，花功夫做的贵**。
 */
export const PRICE_TIERS = {
  basic: 8,      // 现成的：坚果/海苔/饼干/水果
  normal: 14,    // 热一下/泡一下：茶/牛奶/咖啡/面包/饭团
  advanced: 25,  // 要做的：三明治/汤/面/甜品
};

/** 商品名 → 档位。 */
const TIER_RULES = [
  // ① 例外优先：字面含「饭/烤」但属于常规档
  { re: /饭团|烤面包|吐司|包子|馒头/, tier: 'normal' },
  // ② 进阶：要做的（花功夫）
  { re: /三明治|汉堡|堡|卷|面|粉|饭|粥|汤|锅|蛋糕|塔|派|布丁|甜品|甜点|慕斯|意面|披萨/, tier: 'advanced' },
  // ③ 常规：热一下/泡一下
  { re: /咖啡|拿铁|美式|卡布|茶|牛奶|豆浆|果汁|饮|面包|烤/, tier: 'normal' },
  // ④ 基础：现成的
  { re: /饼干|曲奇|坚果|小食|零嘴|海苔|水果|草莓|苹果|橘子|酒/, tier: 'basic' },
];
const DEFAULT_TIER = 'normal';

/** 从清单「吃喝」节提取候选商品名。 */
export function extractFoodItems(markdown) {
  const md = String(markdown ?? '');
  if (!md) return [];

  // 找 ## 吃喝 / ## 吃 / ## 饮食 这一节
  const lines = md.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s*(吃喝|饮食|食物|吃)\b/.test(lines[i]) || /^##\s*吃喝/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return [];

  const items = [];
  /** 当前子节：'like' | 'dislike' | 'say' | '' */
  let section = '';

  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^##\s/.test(raw)) break;   // 下一大节

    const t = raw.trim();
    if (!t) continue;

    // 子节标题：### 爱 / ### 不爱 / ### 她会说的
    const h = /^#{3,}\s*(.+)$/.exec(t);
    if (h) {
      const title = h[1].trim();
      if (/不爱|不喜欢|讨厌|不喝|不吃/.test(title)) section = 'dislike';
      else if (/会说|习惯|口头/.test(title)) section = 'say';
      else if (/^爱|喜欢/.test(title)) section = 'like';
      else section = '';
      continue;
    }

    // ⚠️ 只从「爱」节提取 —— 其他节的句子不是商品
    if (section !== 'like') continue;

    // 形式 1：`- **自己做的**——三明治、简单的汤、烤面包`
    const mBold = /^[-*]\s*\*\*(.+?)\*\*\s*(?:——|—|--)?\s*(.*)$/.exec(t);
    if (mBold) {
      // 粗体本身可以是商品（如 **蜂蜜吐司边**），也可能是修饰（如 **自己做的**）
      const bold = cleanName(mBold[1]);
      const rest = mBold[2] || '';
      // 粗体是"自己做的/手工的"这类修饰 → 只取后面列举的
      if (/^(自己|手工|别人|外面|家里|亲手|简单|好吃|清淡|清淡的|普通|家常|随便)/.test(bold)) {
        for (const p of rest.split(/[、,，/]/)) {
          const n = cleanName(p);
          if (n) items.push(n);
        }
      } else {
        if (bold) items.push(bold);
      }
      continue;
    }

    // 形式 2：`- 热牛奶` 或 `- 海苔（和鲸鱼有点关系…）`
    const m2 = /^[-*]\s*(.+)$/.exec(t);
    if (!m2) continue;
    const body = m2[1];

    // 去掉破折号/引号后的解释
    const core = body
      .replace(/——.*$/, '')
      .replace(/[「『].*$/, '')
      .replace(/[（(].*?[）)]/g, '')
      .trim();

    // 长句/带标点的 → 不是商品名
    if (core.length > 12) continue;
    if (/[？?！!。，,]/.test(core)) continue;

    // 顿号分隔的多个
    for (const p of core.split(/[、/]/)) {
      const n = cleanName(p);
      if (n) items.push(n);
    }
  }

  // 去重 + 过滤
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const n = String(it ?? '').trim();
    if (!n || n.length > 12 || n.length < 1) continue;
    if (seen.has(n)) continue;
    // 过滤明显不是商品的
    if (/^(--|—|自己|别人|外卖|生的|太|不|啥|都|还|但|先|别)/.test(n)) continue;
    if (/[？?！!。，,]/.test(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 清洗商品名（去标点/解释）。 */
function cleanName(s) {
  return String(s ?? '')
    .replace(/[「」『』""'']/g, '')
    .replace(/——.*$/, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[。，,、.！!？?；;：:]/g, '')
    .trim()
    .slice(0, 12);
}

/** 按名字判档位（向钱看的分类，贴人设：现成的便宜、花功夫的贵）。 */
export function tierOf(name) {
  const n = String(name ?? '');
  for (const { re, tier } of TIER_RULES) {
    if (re.test(n)) return tier;
  }
  return DEFAULT_TIER;
}

/**
 * 按名字定价（三档）。
 *
 * @param {string} name 商品名
 * @param {object} [tiers] 可选覆盖 {basic,normal,advanced}（接积分配置时传）
 */
export function guessPrice(name, tiers) {
  const t = tiers && typeof tiers === 'object' ? tiers : PRICE_TIERS;
  const tier = tierOf(name);
  const v = Number(t[tier]);
  return Number.isInteger(v) && v > 0 ? v : PRICE_TIERS[tier];
}

/** 特供商品名前缀（用于卡片/菜单识别"这是特供"）。 */
export const SPECIAL_OFFER_PREFIX = '今日特供·';

/** 判断某个商品名是不是特供。 */
export function isSpecialOffer(name) {
  return String(name ?? '').startsWith(SPECIAL_OFFER_PREFIX);
}

/** 默认菜单池（人格没清单时用；不绑定任何具体人格）。 */
export const DEFAULT_MENU_POOL = [
  { name: '三明治', price: 8 },
  { name: '热饮', price: 5 },
  { name: '小食', price: 4 },
  { name: '饭团', price: 5 },
  { name: '汤', price: 7 },
  { name: '甜点', price: 6 },
];

/** 静态兜底（连默认池都不可用时）。 */
const STATIC_FALLBACK = [
  { name: '三明治', price: 8 },
  { name: '热饮', price: 5 },
];

/**
 * 生成今日菜单。
 *
 * @param {{personaName:string, personaRoot?:string, cfg?:object, random?:()=>number, logger?:object}} p
 * @returns {Promise<Array<{name:string, price:number, qty:number}>>}
 */
export async function buildMenu(p) {
  const cfg = { ...DEFAULT_CONFIG, ...(p.cfg || {}) };
  const random = typeof p.random === 'function' ? p.random : Math.random;
  const sizeMin = Math.max(1, cfg.menuSize?.min ?? 3);
  const sizeMax = Math.max(sizeMin, cfg.menuSize?.max ?? 5);
  const size = sizeMin + Math.floor(random() * (sizeMax - sizeMin + 1));
  const qtyMin = Math.max(1, cfg.stockPerItem?.min ?? 8);
  const qtyMax = Math.max(qtyMin, cfg.stockPerItem?.max ?? 15);

  let candidates = [];

  // ① 从人格清单提取
  try {
    const root = String(p.personaRoot ?? '').trim();
    const name = String(p.personaName ?? '').trim();
    if (root && name) {
      const f = join(root, '人生清单', `${name}.md`);
      if (existsSync(f)) {
        const md = readFileSync(f, 'utf8');
        candidates = extractFoodItems(md).map((n) => ({ name: n, price: guessPrice(n) }));
      }
    }
  } catch (e) {
    p.logger?.warn?.(`[shop] 读人格清单失败（降级到默认菜单）: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ② 人格没清单 → 默认池
  if (candidates.length === 0) {
    candidates = DEFAULT_MENU_POOL.map((x) => ({ ...x }));
  }

  // ③ 连默认池都空 → 静态兜底
  if (candidates.length === 0) {
    candidates = STATIC_FALLBACK.map((x) => ({ ...x }));
  }

  // 随机挑 size 种（不重复）
  const pool = candidates.slice();
  const picked = [];
  while (picked.length < size && pool.length > 0) {
    const idx = Math.floor(random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }

  const menu = picked.map((x) => {
    const qty = qtyMin + Math.floor(random() * (qtyMax - qtyMin + 1));
    return { name: x.name, price: Math.max(0, Number(x.price) || DEFAULT_PRICE), qty };
  });

  // ④ 今日特供（每天 1 件，限量 1 份，价格 50/100）
  //    依据：Bot/维护/全局积分系统-最终定稿-20261117.md 细节 6
  const special = buildSpecialOffer({ cfg, candidates, menu, random });
  if (special) menu.push(special);

  return menu;
}

/**
 * 生成今日特供（拿不到候选就返回 null）。
 *
 * @param {{cfg:object, candidates:Array, menu:Array, random:()=>number}} p
 * @returns {{name:string, price:number, qty:number, special:true}|null}
 */
export function buildSpecialOffer(p) {
  const cfg = p.cfg || {};
  if (cfg.specialOfferEnabled === false) return null;

  const prices = Array.isArray(cfg.specialOfferPrices) && cfg.specialOfferPrices.length > 0
    ? cfg.specialOfferPrices.filter((x) => Number.isInteger(x) && x > 0)
    : [50, 100];
  if (prices.length === 0) return null;

  // ★ 避开当天已有的常规商品，避免「三明治」在菜单里出现两次
  const usedNames = new Set((Array.isArray(p.menu) ? p.menu : []).map((x) => String(x?.name ?? '')));
  let pool = (Array.isArray(p.candidates) && p.candidates.length > 0 ? p.candidates : [])
    .filter((x) => !usedNames.has(String(x?.name ?? '')));
  // 全被占了（菜单很大）→ 退回允许重复，但不至于没有特供
  if (pool.length === 0) {
    pool = Array.isArray(p.candidates) && p.candidates.length > 0
      ? p.candidates
      : (Array.isArray(p.menu) ? p.menu : []);
  }
  if (pool.length === 0) return null;

  const random = typeof p.random === 'function' ? p.random : Math.random;
  const base = pool[Math.floor(random() * pool.length)];
  const baseName = String(base?.name ?? '').trim();
  if (!baseName) return null;

  const price = prices[Math.floor(random() * prices.length)];
  const count = Math.max(1, Math.floor(Number(cfg.specialOfferCount) || 1));

  return {
    name: SPECIAL_OFFER_PREFIX + baseName,
    price,
    qty: count,
    special: true,
  };
}