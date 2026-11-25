/**
 * work_fact — 查询作品事实（防编造）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个工具（2026-11-16）
 *
 * 实测风险：AI 谈具体作品会**系统性编错**——
 *   · 把《起风了》的歌词写成"曾梦想仗剑走天涯"（那是《曾经的你》）
 *   · 说《紫罗兰永恒花园》"主角是会写信的男孩"（主角是薇尔莉特，女性）
 *   · 说《来自深渊》"结局是他们走出来了"（**原作根本没完结**）
 *   · 说《TruE》是"周杰伦唱的"（是黄龄）
 *
 * 这不是偶发，是模型对流行文化细节的记忆本来就不可靠。
 *
 * ── 解决方式 ───────────────────────────────────────────────────────────────
 * 建**本地事实库**：{PERSONA_ROOT}/事实库/{音乐,番剧}/<作品名>.md
 * 预先写好准确事实 + **明确"她不会做什么"**，查询时直接返回。
 *
 * 三档保护（本工具负责 ①②）：
 *   ① 有事实卡 → 用卡里的准确信息
 *   ② 有卡但某项"待核实/空" → 返回警示"这项不确定，说记不清"
 *   ③ 完全没卡 → 返回"她没看过/没听过"，**绝不装懂**
 *
 * ⚠️ 为什么不用 web_search：
 *   慢（首字延迟 +3~5s）、可能搜到错信息、费 token。
 *   这些作品事实是**固定的**，一次写死长期可用，本地读取零延迟零成本。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONA_ROOT } from '../lib/io/persona-store.mjs';
// ★ 2026-11-17 统一人格路径（原先直接 join(PERSONA_ROOT,'事实库') 不分人格，
//   导致群 AAAA0001 切到比安安后仍在读爱莉的事实库）
import { resolveDataDir, currentPersonaOf } from '../lib/io/persona-path.mjs';

/**
 * 事实库根（★ 按人格隔离）。
 *
 * 查找顺序：
 *   ① <PERSONA_ROOT>/事实库/<当前人格>/   （新结构）
 *   ② <PERSONA_ROOT>/事实库/              （旧结构，存量兼容）
 *
 * @param {object} env 工具 env（含 peer，用来判断当前群是谁的人格）
 */
function factRoot(env) {
  return resolveDataDir('事实库', env, existsSync);
}

/** 支持的子目录（音乐 / 番剧）。 */
const KINDS = {
  music: '音乐',
  anime: '番剧',
  book: '书',
  game: '游戏',
};

/** 清洗作品名：去掉书名号/引号/空格，防路径穿越。 */
export function cleanTitle(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^[《"'\u300c\u300e]+/u, '')
    .replace(/[》"'\u300d\u300f]+$/u, '')
    .replace(/[\\/:*?"<>|]/gu, '')
    .replace(/\.\./gu, '')
    .trim()
    .slice(0, 60);
}

/**
 * 在事实库里找作品。返回 { found, path, kind }。
 * 查找顺序：先按 kind 限定，再全库找。
 */
/**
 * 归一化：把所有"看着一样但写起来不同"的差异抹平。
 *
 * ★ 2026-11-16 修（实测发现的真 bug）：
 *   原来只做**精确文件名匹配**，导致清单里的名字查不到事实卡——
 *     "Gymnopédie No.1" → 文件是 "Gymnopedie-No1.md"（é→e、空格→-）
 *     "Make You Feel My Love" → 文件是 "Make-You-Feel-My-Love.md"
 *     "亚托莉 -我挚爱的时光-" → 文件是 "亚托莉-我挚爱的时光.md"（多空格）
 *     "Fate/Zero" → 文件是 "Fate-Zero.md"（/ 被清成空）
 *   表现是"明明有卡，工具却说没有" → 模型就会说"我没看过"，功能白做。
 *
 * 归一规则（顺序重要）：
 *   1) 去书名号/引号
 *   2) Unicode NFD 去重音（é → e）
 *   3) 去所有空白
 *   4) 统一分隔符（- _ / · 全变 -）
 *   5) 小写
 */
/**
 * 繁简归一：把常见的繁体字映射成简体。
 *
 * ★ 2026-11-16 新增。问题：清单里写《简单爱》，卡的文名是「簡單愛.md」；
 *   反过来也有（清单写《楓》，卡名是「楓」）。不做归一化 → 查不到 → 模型说"没看过"。
 *
 * 只覆盖周杰伦歌名里实际出现的字，不做全量繁简表（没必要，也维护不动）。
 */
const T2S = {
  簡:'简',單:'单',愛:'爱',愛:'爱',可:'可',龍:'龙',捲:'卷',風:'风',開:'开',聲:'声',
  葉:'叶',東:'东',聽:'听',調:'调',睫:'睫',毛:'毛',藉:'借',園:'园',遊:'游',會:'会',
  髮:'发',麥:'麦',芽:'芽',糖:'糖',楓:'枫',黑:'黑',色:'色',毛:'毛',衣:'衣',給:'给',
  時:'时',間:'间',說:'说',蘭:'兰',亭:'亭',序:'序',紅:'红',塵:'尘',客:'客',棧:'栈',
  驚:'惊',嘆:'叹',號:'号',煙:'烟',花:'花',雨:'雨',輕:'轻',遠:'远',糖:'糖',稻:'稻',
  香:'香',龍:'龙',戰:'战',騎:'骑',士:'士',蛇:'蛇',舞:'舞',花:'花',海:'海',蘭:'兰',
  給:'给',我:'我',一:'一',首:'首',歌:'歌',時:'时',間:'间',說:'说',好:'好',幸:'幸',
  福:'福',時:'时',光:'光',機:'机',超:'超',人:'人',不:'不',會:'会',飛:'飞',月:'月',
  聲:'声',光:'光',明:'明',就:'就',傻:'傻',笑:'笑',紅:'红',塵:'尘',大:'大',笨:'笨',
  鐘:'钟',烏:'乌',克:'克',麗:'丽',場:'场',景:'景',說:'说',走:'走',就:'走',
  告:'告',白:'白',氣:'气',球:'球',粉:'粉',海:'海',洋:'洋',還:'还',在:'在',流:'流',
  浪:'浪',顏:'颜',如:'如',霜:'霜',錯:'错',過:'过',的:'的',煙:'烟',火:'火',
  最:'最',偉:'伟',大:'大',作:'作',品:'品',說:'说',好:'好',不:'不',哭:'哭',
  等:'等',你:'你',下:'下',課:'课',前:'前',世:'世',情:'情',人:'人',
  天:'天',涯:'涯',過:'过',客:'客',手:'手',寫:'写',從:'从',前:'前',鞋:'鞋',子:'子',
  特:'特',大:'大',號:'号',美:'美',人:'人',魚:'鱼',聽:'听',見:'见',下:'下',雨:'雨',
  歌:'歌',太:'太',陽:'阳',之:'之',子:'子',後:'后',呢:'呢',來:'来',呀:'呀',
  她:'她',不:'不',場:'场',魔:'魔',女:'女',之:'之',旅:'旅',飛:'飞',翔:'翔',
  葬:'葬',送:'送',亞:'亚',托:'托',莉:'莉',紫:'紫',羅:'罗',蘭:'兰',永:'永',恆:'恒',
  孤:'孤',獨:'独',搖:'摇',滾:'滚',莉:'莉',可:'可',麗:'丽',絲:'丝',女:'女',
  武:'武',神:'神',餐:'餐',桌:'桌',間:'间',諜:'谍',過:'过',家:'家',
  鬼:'鬼',滅:'灭',之:'之',刃:'刃',我:'我',獨:'独',自:'自',升:'升',級:'级',
  某:'某',科:'科',學:'学',超:'超',電:'电',磁:'磁',炮:'炮',五:'五',等:'等',分:'分',
  // 补充（实测漏掉的字）
  較:'较',證:'证',據:'据',點:'点',線:'线',號:'号',點:'点',題:'题',樂:'乐',
  歡:'欢',離:'离',別:'别',選:'选',擇:'择',記:'记',憶:'忆',願:'愿',望:'望',
  當:'当',這:'这',邊:'边',裡:'里',個:'个',們:'们',來:'来',對:'对',見:'见',
  無:'无',處:'处',愛:'爱',誰:'谁',嗎:'吗',麼:'么',樣:'样',給:'给',讓:'让',
  覺:'觉',靜:'静',歲:'岁',長:'长',遠:'远',進:'进',現:'现',實:'实',間:'间',
  開:'开',關:'关',於:'于',與:'与',為:'为',將:'将',從:'从',會:'会',經:'经',
  結:'结',束:'束',紹:'绍',終:'终',於:'于',語:'语',讀:'读',聽:'听',寫:'写',
};
function toSimplified(str) {
  let out = '';
  for (const ch of String(str)) out += (T2S[ch] || ch);
  return out;
}

export function normKey(raw) {
  return String(raw ?? '')
    .replace(/^[《"'「『]+/u, '')
    .replace(/[》"'」』]+$/u, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/gu, '')  // é → e
    .toLowerCase()
    // ★ 繁简归一（清单写简体、卡名是繁体时也能匹配）
    .split('').map((c) => T2S[c] || c).join('')
    // ★ 统一抹掉"一切非字母数字汉字"：空格、横线、点、斜杠、下划线、中点、感叹号…
    //   这一步是修复的关键——两边（清单名/文件名）必须用同一套归一化才可能相等。
    .replace(/[^a-z0-9一-鿿぀-ヿ]/gu, '');
}

/** 列出某目录下所有 .md（不含模板）。 */
function listDirFiles(dirName, env) {
  const dir = join(factRoot(env), dirName);
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  } catch { return []; }
}

/**
 * 找事实卡。三级查找：
 *   ① 精确文件名
 *   ② 归一化后完全相等
 *   ③ 归一化后互相包含（取最长匹配，避免 "Fate" 命中 "Fate-Zero" 和 "Fate-EXTRA"）
 *
 * 任何一级命中都返回。找不到才返回 found:false。
 */
export function findFact(title, kind, env) {
  const root = factRoot(env);
  const t = cleanTitle(title);
  if (!t) return { found: false };

  const candidates = kind && KINDS[kind] ? [KINDS[kind]] : Object.values(KINDS);

  // ① 精确
  for (const dirName of candidates) {
    const p = join(root, dirName, `${t}.md`);
    if (existsSync(p)) return { found: true, path: p, kind: dirName };
  }

  // ② 归一化相等
  const wantKey = normKey(t);
  if (!wantKey) return { found: false };
  for (const dirName of candidates) {
    for (const f of listDirFiles(dirName, env)) {
      const base = f.replace(/\.md$/u, '');
      if (normKey(base) === wantKey) {
        return { found: true, path: join(root, dirName, f), kind: dirName };
      }
    }
  }

  // ②b 别名匹配（★ 2026-11-16 新增）
  //   问题：卡里文件名是「新世纪福音战士」，但人会说「EVA」→ 精确/包含都匹配不上 → 查不到。
  //   做法：卡的「基本信息」里可以写一行 `- 别名：EVA / Evangelion`，
  //         工具读取该行，把每个别名也纳入匹配。
  for (const dirName of candidates) {
    for (const f of listDirFiles(dirName, env)) {
      const p = join(root, dirName, f);
      let head = '';
      try { head = readFileSync(p, 'utf8').slice(0, 800); } catch { continue; }
      const m = /^-\s*别名[:：]\s*(.+)$/mu.exec(head);
      if (!m) continue;
      const aliases = m[1].split(/[\/、,，|]/u).map((x) => normKey(x.trim())).filter(Boolean);
      if (aliases.includes(wantKey)) {
        return { found: true, path: p, kind: dirName, alias: true };
      }
    }
  }

  // ③ 包含匹配（取最长 base，最具体）
  let best = null;
  for (const dirName of candidates) {
    for (const f of listDirFiles(dirName, env)) {
      const base = f.replace(/\.md$/u, '');
      const baseKey = normKey(base);
      if (!baseKey) continue;
      if (baseKey.includes(wantKey) || wantKey.includes(baseKey)) {
        if (!best || baseKey.length > best.key.length) {
          best = { key: baseKey, path: join(root, dirName, f), kind: dirName, base };
        }
      }
    }
  }
  if (best) return { found: true, path: best.path, kind: best.kind, fuzzy: true };

  return { found: false };
}

/** 列出事实库里已有的作品（诊断/兜底用）。 */
export function listFacts(env) {
  const root = factRoot(env);
  const out = [];
  for (const dirName of Object.values(KINDS)) {
    const dir = join(root, dirName);
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.md')) out.push({ kind: dirName, title: f.replace(/\.md$/, '') });
      }
    } catch { /* 目录不存在 → 跳过 */ }
  }
  return out;
}

/**
 * 解析事实卡：按 `## 小节` 切分。
 * 同时识别「待核实 / TODO / 待填」→ 标记为不确定项。
 */
export function parseFact(md) {
  const sections = {};
  let cur = '';
  for (const rawLine of String(md ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    // ⚠️ 2026-11-16 修：原来跳过**所有** `>` 行 → 把「她最喜欢的那句」「记得的几句」
    //   里的引用块金句也一起吞了（实测：lyrics 模式返回空）。
    //   现在只跳过**说明性**引用（含"版权提示/TODO/⚠️/注："这类），保留真正的金句。
    if (/^\s*>/.test(line)) {
      const inner = line.replace(/^\s*>\s?/, '');
      if (/版权提示|TODO|待核实|待填|⚠️|^注[:：]/u.test(inner)) continue;   // 说明性，跳过
      // 正文引用（金句/台词）→ 保留，去掉 > 前缀
      if (cur && inner.trim()) sections[cur].push(inner.trimEnd());
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) { cur = h2[1].trim(); sections[cur] = []; continue; }
    if (cur && line.trim()) sections[cur].push(line);
  }
  // 标记不确定项
  const uncertain = [];
  for (const [name, lines] of Object.entries(sections)) {
    const joined = lines.join('\n');
    if (/TODO|待填|待核实|\?\?\?/u.test(joined)) uncertain.push(name);
  }
  return { sections, uncertain };
}

/** 把某几节渲染成文本。 */
function renderSections(sections, names) {
  const out = [];
  for (const n of names) {
    const lines = sections[n];
    if (!lines || !lines.length) continue;
    out.push(`【${n}】`, ...lines, '');
  }
  return out.join('\n').trim();
}

export default {
  name: 'work_fact',
  expose: 'qq',
  description:
    '查询某个音乐/番剧/书的**准确事实**（讲什么、谁做的、完结没）。'
    + '当有人问"这首歌是谁唱的""这部番讲了什么""结局了吗"时**必须先调它**——'
    + '不要凭记忆答，模型对流行文化细节容易编错（歌词、主角、结局都是高发错误）。'
    + '查不到就说明她没看过/没听过，**绝不装懂**。',

  inputSchema: {
    title: {
      type: 'string',
      required: true,
      description: '作品名（如"TruE"、"紫罗兰永恒花园"），不用带书名号',
    },
    kind: {
      type: 'string',
      enum: ['music', 'anime', 'book', 'game'],
      description: '可选：作品类型，加速查找',
    },
    aspect: {
      type: 'string',
      enum: ['basic', 'plot', 'lyrics', 'caution', 'all'],
      description: '想看哪部分：basic 基本信息 / plot 讲什么 / lyrics 歌词（只给金句，不给全文）/ caution 她不会做什么 / all 全部',
    },
  },

  async run(args = {}, env = {}) {
    const title = String(args?.title ?? '').trim();
    if (!title) return { ok: false, msg: '需要 title（作品名）' };

    const hit = findFact(title, String(args?.kind ?? ''), env);
    if (!hit.found) {
      const all = listFacts(env);
      const hint = all.length
        ? `事实库里只有这些：${all.slice(0, 12).map((x) => `${x.title}(${x.kind})`).join('、')}${all.length > 12 ? '…' : ''}`
        : '事实库还是空的。';
      return {
        ok: true,
        msg:
          `事实库里没有「${cleanTitle(title)}」。\n`
          + `⇒ **不要编内容**。如果是她"没听过/没看过"的，就诚实说没看过；\n`
          + `   如果只是这库没收录，也只说"记得不太清了"，不编具体细节。\n`
          + hint,
        data: { title: cleanTitle(title), found: false },
      };
    }

    let md = '';
    try {
      md = readFileSync(hit.path, 'utf8');
    } catch (err) {
      return { ok: false, msg: `读事实卡失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const { sections, uncertain } = parseFact(md);
    const aspect = String(args?.aspect ?? 'all');
    let lyricGuard = false;

    // 选节
    let picked = [];
    if (aspect === 'all') {
      // ★ 即使 all，也**排除「歌词全文」节**（只给金句）
      picked = Object.keys(sections).filter((n) => !/^歌词全文$/u.test(n));
    } else if (aspect === 'basic') {
      picked = Object.keys(sections).filter((n) => /基本信息|名称|作者/u.test(n));
    } else if (aspect === 'lyrics') {
      // ★ 歌词特殊处理（2026-11-16，主人选 B 方案）：
      //   事实卡里**存了完整歌词**，但工具**只返回金句**，绝不把全文交给模型。
      //   理由：存全文是为了"内部理解准确"，但把全文塞进上下文会让模型有机会背出来 → 像点读机。
      //   所以：全文留在文件里当"校验依据"，对外只给「最喜欢那句 + 记得的几句」。
      picked = Object.keys(sections).filter((n) => /她最喜欢的那句|记得的几句/u.test(n));
      // 加一条硬约束（在下面统一追加）
      lyricGuard = true;
    } else if (aspect === 'plot') {
      picked = Object.keys(sections).filter((n) => /讲什么|剧情|内容|主要角色/u.test(n));
    } else if (aspect === 'caution') {
      picked = Object.keys(sections).filter((n) => /边界|不会|注意/u.test(n));
    }
    if (!picked.length) picked = Object.keys(sections).filter((n) => !/^已验证$/u.test(n));

    const body = renderSections(sections, picked);

    const lines = [
      `（以下是「${hit.title || cleanTitle(title)}」的**事实卡**，据实回答，不要补充卡里没有的细节。）`,
      '',
      body,
    ];

    // ⚠️ 不确定项警示（这是防编造的核心）
    if (uncertain.length) {
      lines.push(
        '',
        `⚠️ 以下部分**尚未核实**（${uncertain.join('、')}）：`,
        '   被问到这些时只说"记不太清了"或"我得想想"，**绝对不要编**。',
      );
    }

    // ★ 歌词硬约束（2026-11-16）
    if (lyricGuard || /她最喜欢的那句|记得的几句/u.test(picked.join(''))) {
      lines.push(
        '',
        '⛔【歌词硬约束，必须遵守】',
        '   · 你**只记得**上面列出的那几句，其余歌词一律记不清。',
        '   · 被问"歌词是什么/背一段" → 说"我记不全了，就记得那两句"。',
        '   · **绝对不要**自己往下接词、补词、编词。',
        '   · 被要求"唱两句" → 最多哼「她最喜欢的那句」，不继续。',
        '   · 有人替你念了歌词 → 可以接"对，就是这句"，但不跟着背下一句。',
      );
    }

    // 读书籍/音乐统一加兜底
    lines.push(
      '',
      '【记住】卡里没有的细节 = 不知道。不要为了回答完整而虚构歌词、剧情、结局。',
    );

    return {
      ok: true,
      msg: lines.join('\n'),
      data: { title: cleanTitle(title), kind: hit.kind, uncertain },
    };
  },
};
