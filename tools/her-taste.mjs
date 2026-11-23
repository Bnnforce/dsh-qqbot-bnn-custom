/**
 * her_taste — 查询「她喜欢什么」（人生清单）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个工具（2026-11-16）
 *
 * 问题：如果把"她喜欢听什么歌/看什么番"直接写进人格卡，
 *   人格卡是**每轮全文注入**的 → 每轮白烧 1200+ 字，而大多数对话根本聊不到歌。
 *
 * 做法：清单独立成文件，**只在被问到的时候查**。不查 = 零成本。
 *
 * 这更接近真人：人问"你最近听什么歌"，会想一下再去翻记忆，
 *   不是张口背清单。查过之后说的，才像"想起"。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 数据源：{PERSONA_ROOT}/人生清单/<人格名>.md
 * 解析规则：
 *   · `## 标题`     → 分类（音乐/番剧/书和故事/游戏/吃喝/小习惯/雷区）
 *   · `### 标题`    → 子分类（场景/时段）
 *   · `- 开头`      → 条目
 *
 * ⚠️ 纪律：
 *   · **只读**，不改任何文件
 *   · 路径硬编码 PERSONA_ROOT，不接受任意路径（防穿越）
 *   · 找不到该人格的清单 → 友好提示，不抛错
 *   · 本工具只返回**事实**，不生成对话（她怎么说由模型决定）
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONA_ROOT } from '../lib/io/persona-store.mjs';
// ★ 2026-11-17 统一人格解析（原先本文件自己实现了一份，与 work_fact/her_slang 不一致）
import { currentPersonaOf } from '../lib/io/persona-path.mjs';

/** 分类 key → 中文标题（清单文件里用的） */
const CATEGORY_MAP = {
  music: '音乐',
  anime: '番剧',
  book: '书和故事',
  game: '游戏',
  food: '吃喝',
  habit: '小习惯',
  dislike: '雷区',
};

/** 清单目录。 */
function listDir() {
  return join(PERSONA_ROOT, '人生清单');
}

/**
 * 解析 md 成 { 分类: { 子分类: [条目] } }。
 *
 * 容错要求：任何异常 → 返回空结构（不抛）。
 */
export function parseChecklist(md) {
  const out = {};
  let curCat = '';
  let curSub = '';
  for (const rawLine of String(md ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    // 跳过引用块（> 开头，都是说明文字）
    if (/^\s*>/.test(line)) continue;
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) { curCat = h2[1].trim(); curSub = ''; if (!out[curCat]) out[curCat] = {}; continue; }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) { curSub = h3[1].trim(); if (curCat && !out[curCat][curSub]) out[curCat][curSub] = []; continue; }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item && curCat) {
      const key = curSub || '_';
      if (!out[curCat][key]) out[curCat][key] = [];
      out[curCat][key].push(item[1].trim());
    }
  }
  return out;
}

/** 渲染成给模型看的文本。 */
/**
 * 偏好档排序权重（2026-11-16 新增）。
 *
 * 问题：问"你最喜欢什么"，原来返回 78 行平铺清单 → 模型得自己从 115 首里挑，实测思考 3.3s。
 * 解法：事实卡里有 `- 偏好：S/A/B/C` 字段，按档排序后 S 级置顶带 ★，
 *       模型取前几个直接说，不用自己排序。
 * 档位来源见 Bot/维护/验证/rank-preference.mjs（以人生清单分节为主判据）。
 */
const GRADE_WEIGHT = { S: 0, A: 1, B: 2, C: 3 };
const GRADE_RANK = { S: 0, A: 1, B: 2, C: 3 };

/**
 * S 级内部分层（2026-11-16 实测修正）。
 *
 * 问题：TruE（她本体）、群青/粉色海洋（最近在循环）**都是 S**，
 * 排序时按清单出现顺序，导致"最近在循环"排到了"她自己"之前 —— 不合理。
 * 修法：S 内部再分三层，**她本体永远第一**。
 */
const S_TIER = {
  '她本体': 0,        // TruE / 妖精小姐 / 崩坏3 / 女武神的餐桌
  '清单·★': 1,        // ★ 节里的
  '清单·最近在循环': 1,
  '清单·特别的那几首': 1,
};
function sTier(why) {
  if (!why) return 2;
  if (why.includes('她本体')) return 0;
  if (why.includes('★') || why.includes('最近在循环') || why.includes('特别的那几首')) return 1;
  return 2;
}

/**
 * 档位索引：作品名（归一化）→ S/A/B/C
 *
 * ★ 单一数据源：档位只写在**事实卡**里（`- 偏好：S`），由
 *   `Bot/维护/验证/rank-preference.mjs` 批量生成。
 *   本工具读卡建索引，**不再往清单里塞第二份档位** —— 避免"两份数据要同步"的老坑。
 *
 * 缓存：按 事实库 目录的 mtime 判断是否重建（改卡后自动失效）。
 */
let _gradeIdx = null;
let _gradeIdxKey = '';
function normTitle(x) {
  return String(x).replace(/[《》「」""'']/g, '')
    .replace(/[？?。，，.、\s·・\-—_～~！!]/g, '').toLowerCase();
}
function gradeIndexOf(personaRoot, persona, statSyncFn, readdirSyncFn, readFileSyncFn, joinFn) {
  const dirs = ['音乐', '番剧', '书', '游戏'];
  // ★ 2026-11-17：事实库按人格分子目录（事实库/<人格>/<kind>）
  const base = persona ? joinFn(personaRoot, '事实库', persona) : joinFn(personaRoot, '事实库');
  let key = '';
  for (const d of dirs) {
    try { key += d + ':' + statSyncFn(joinFn(base, d)).mtimeMs + ';'; } catch { /* 无该目录 */ }
  }
  if (_gradeIdx && key === _gradeIdxKey) return _gradeIdx;

  const idx = new Map();
  for (const d of dirs) {
    const dir = joinFn(base, d);
    let files = [];
    try { files = readdirSyncFn(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue;
      let txt = '';
      try { txt = readFileSyncFn(joinFn(dir, f), 'utf8').slice(0, 1200); } catch { continue; }
      const m = /^-\s*偏好[:：]\s*\**([SABC])\**（([^）]*)）/mu.exec(txt)
        || /^-\s*偏好[:：]\s*\**([SABC])\**/mu.exec(txt);
      if (m) {
        idx.set(normTitle(f.replace(/\.md$/, '')), {
          grade: m[1],
          tier: sTier(m[2] || ''),
        });
      }
    }
  }
  _gradeIdx = idx;
  _gradeIdxKey = key;
  return idx;
}

/** 从清单条目里抽《作品名》→ 查档位索引；查不到按 A。返回 { grade, tier } */
function gradeOfLine(line, idx) {
  const m = /《([^》]+)》/.exec(line);
  if (!m) return { grade: 'A', tier: 2 };
  return idx.get(normTitle(m[1])) || { grade: 'A', tier: 2 };
}

function render(catName, subs, topN = 0, idx = new Map()) {
  // 收集成扁平条目，保留来源子类
  // ★ 一行里可能塞多首（如「《A》《B》《C》」）→ 拆成多个条目再排序/去重，
  //   否则去重只认第一个《》，后面的会重复出现（2026-11-16 实测踩到）。
  const rows = [];
  for (const [sub, items] of Object.entries(subs)) {
    for (const it of items) {
      const names = [...it.matchAll(/《([^》]+)》/g)].map((m) => m[1]);
      if (names.length > 1 && it.replace(/《[^》]+》/g, '').trim().length < 20) {
        for (const n of names) {
          const g2 = idx.get(normTitle(n)) || { grade: 'A', tier: 2 };
          rows.push({ sub, text: `《${n}》`, grade: g2.grade, tier: g2.tier });
        }
      } else {
        const g2 = gradeOfLine(it, idx);
        rows.push({ sub, text: it, grade: g2.grade, tier: g2.tier });
      }
    }
  }
  // 按档排序（同档内保持原顺序 = 清单顺序）
  rows.sort((a, b) => {
    const g = (GRADE_WEIGHT[a.grade] ?? 9) - (GRADE_WEIGHT[b.grade] ?? 9);
    if (g !== 0) return g;
    return (a.tier ?? 2) - (b.tier ?? 2);   // 同档内按 S 分层
  });

  // 去重：同一作品在多个子节出现时，只留第一次（排序后=最高档那次）
  const seen = new Set();
  const dedup = [];
  for (const r of rows) {
    const m = /《([^》]+)》/.exec(r.text);
    const key = m ? normTitle(m[1]) : r.text;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(r);
  }

  const picked = topN > 0 ? dedup.slice(0, topN) : dedup;
  const lines = [`【${catName}】`];
  let curSub = '';
  for (const r of picked) {
    if (r.sub !== '_' && r.sub !== curSub) { lines.push(`· ${r.sub}：`); curSub = r.sub; }
    const star = r.grade === 'S' ? '★ ' : '';
    lines.push(`  - ${star}${r.text}`);
  }
  if (topN > 0 && dedup.length > topN) {
    lines.push(`  （共 ${dedup.length} 条，这里只列最靠前的 ${topN} 条）`);
  }
  return lines.join('\n');
}

export default {
  name: 'her_taste',
  expose: 'qq',
  description:
    '查询「她喜欢什么」——常听的歌/爱看的番/爱玩的游戏/吃喝/小习惯/雷区。'
    + '被问到"你喜欢什么""你最近听什么歌""你爱看什么番""你爱玩什么游戏"时调用。'
    + '只返回事实清单，你要用自己的语气说出来，不要照读。'
    + '⚠️ 这只是"她喜欢什么"；问某个作品**具体讲了什么**要用 work_fact 工具。',

  inputSchema: {
    category: {
      type: 'string',
      enum: ['all', 'music', 'anime', 'book', 'game', 'food', 'habit', 'dislike'],
      description: '要查的分类；all = 全部（慎用，会返回很多）',
    },
    mood: {
      type: 'string',
      enum: ['morning', 'night', 'happy', 'daze'],
      description: '可选：按场景查歌（仅 category=music 时有效）',
    },
    query: {
      type: 'string',
      description: '可选：关键词搜索（如"民谣""治愈""最近"），会全文匹配条目',
    },
    top: {
      type: 'integer',
      description: '可选：只返回前 N 条（按偏好档 S>A>B>C 排序，S 级带 ★）。'
        + '⚠️ 被问"你最喜欢什么/最爱的"时**务必传 top=3~5** —— 大幅减少你要挑的时间。'
        + '默认 10；想看全量传 all=true。',
    },
    all: {
      type: 'boolean',
      description: '可选：true=返回全部条目（不截断）。一般聊天不需要，只在"你都喜欢什么"这类问题用。',
    },
  },

  async run(args = {}, env = {}) {
    const persona = currentPersonaOf(env);
    if (!persona) return { ok: false, msg: '拿不到当前人格名，查不了清单。' };

    const file = join(listDir(), `${persona}.md`);
    // 路径安全：挡掉任何带 .. 或 / 的人格名（persona 来自配置，理论上安全，仍做防御）
    if (!file.startsWith(listDir())) return { ok: false, msg: '人格名非法。' };

    if (!existsSync(file)) {
      return {
        ok: true,
        msg: `「${persona}」还没有人生清单。被问到喜好时，就按性格随口说，别硬编具体作品名。`,
        data: { persona, exists: false },
      };
    }

    let md = '';
    try {
      md = readFileSync(file, 'utf8');
    } catch (err) {
      return { ok: false, msg: `读清单失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const parsed = parseChecklist(md);
    const cat = String(args?.category ?? 'all').trim();
    const mood = String(args?.mood ?? '').trim();
    const q = String(args?.query ?? '').trim().toLowerCase();

    // ── 偏好档 + 截断（2026-11-16）──
    //   all=true → 全量；否则默认只返回前 10 条（按 S>A>B>C 排序）。
    //   为什么默认截断：全量 813 token、模型还要自己挑（实测思考 3.3s）；
    //   截断后 5-10 行，模型直接照着说。
    const wantAll = args?.all === true;
    const topRaw = Number(args?.top);
    const topN = wantAll ? 0 : (Number.isFinite(topRaw) && topRaw > 0 ? Math.min(50, Math.floor(topRaw)) : 10);

    // 档位索引（读事实卡里的 `- 偏好：S`，单一数据源）
    let idx = new Map();
    try {
      idx = gradeIndexOf(PERSONA_ROOT, persona, statSync, readdirSync, readFileSync, join);
    } catch { /* 索引失败 → 全部按 A，不阻断 */ }


    // ── 选分类 ──
    const wanted = cat === 'all'
      ? Object.keys(CATEGORY_MAP).map((k) => CATEGORY_MAP[k])
      : [CATEGORY_MAP[cat]].filter(Boolean);

    if (!wanted.length) {
      return { ok: false, msg: `不认识的分类「${cat}」。可用：${Object.keys(CATEGORY_MAP).join(' / ')} / all` };
    }

    const blocks = [];
    // 清单的 ## 标题可能带括号后缀（如「雷区（别人踩到会不高兴）」）→ 精确找不到就包含匹配
    const findSubs = (name) => {
      if (parsed[name]) return parsed[name];
      const key = Object.keys(parsed).find((k) => k.startsWith(name) || k.includes(name));
      return key ? parsed[key] : null;
    };

    for (const catName of wanted) {
      const subs = findSubs(catName);
      if (!subs) continue;

      // mood 过滤（只对音乐生效）
      if (catName === '音乐' && mood) {
        // ★ 2026-11-16 修：原来要求子类标题**完全相等**（`subs['早上']`），
        //   但清单改版后标题变成「周杰伦 · 早上（轻快、甜）」，精确匹配必失配 → mood 查询永远空。
        //   改成**包含匹配**：只要子类标题含"早上"就算命中。
        const moodMap = { morning: '早上', night: '深夜', happy: '心情好', daze: '想发呆' };
        const target = moodMap[mood];
        if (target) {
          const hitSubs = {};
          for (const [sub, items] of Object.entries(subs)) {
            if (sub.includes(target)) hitSubs[sub] = items;
          }
          if (Object.keys(hitSubs).length) {
            for (const [sub, items] of Object.entries(hitSubs)) {
              blocks.push(render(`音乐 · ${sub}`, { [sub]: items }, 0, idx));
            }
          }
        }
        // mood 查完就跳到下一类（别的类不受 mood 影响）
        continue;
      }

      // query 过滤（全文匹配条目）
      if (q) {
        const hitSubs = {};
        for (const [sub, items] of Object.entries(subs)) {
          const hits = items.filter((it) => it.toLowerCase().includes(q));
          if (hits.length) hitSubs[sub] = hits;
        }
        if (Object.keys(hitSubs).length) blocks.push(render(`${catName}（搜"${args.query}"）`, hitSubs, 0, idx));
        continue;
      }

      blocks.push(render(catName, subs, topN, idx));
    }

    if (!blocks.length) {
      return {
        ok: true,
        msg: `清单里没找到${q ? `"${args.query}"相关内容` : '对应内容'}。可以按性格随口说，别硬编。`,
        data: { persona, category: cat, empty: true },
      };
    }

    const head = `（以下是「${persona}」的真实偏好清单。用你自己的语气挑着说，不要照读、不要一次全倒出来。）`;
    return {
      ok: true,
      msg: [head, '', ...blocks].join('\n'),
      data: { persona, category: cat, mood: mood || null, query: q || null },
    };
  },
};
