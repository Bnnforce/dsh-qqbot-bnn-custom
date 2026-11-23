/**
 * slang/store — 黑话本的读写
 *
 * ★ 数据分离原则（工业化核心）：
 *   · 黑话.md   已确认 → **会被读取/注入**
 *   · 候选.md   待确认 → **只给人看，绝不注入**
 *
 * 这样保证：自动挖掘误判的内容**永远不会**进模型上下文。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { GID_PATTERN, SLANG_SUBDIR, MAX_SLANG_PER_GROUP, MAX_DEFINITION_LEN, INLINE_MAX_CHARS, INLINE_TOP_N } from './config.mjs';

/** 原子写：临时文件 + rename（开发规则红线）。 */
export function writeAtomic(path, text) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/** 黑话本根目录。 */
export function slangRoot(personaRoot) {
  return join(personaRoot, SLANG_SUBDIR);
}

/** 某个群的目录（gid 严格校验，防穿越）。 */
export function groupDir(personaRoot, gid) {
  const g = String(gid || '');
  if (!GID_PATTERN.test(g)) return null;
  return join(slangRoot(personaRoot), g.slice(0, 8));
}

/**
 * 解析 黑话.md → [{ word, definition, usage }]
 *
 * 格式约定（严格）：
 *   ## 词
 *   - 释义：xxx
 *   - 出处：xxx
 *   - 用法：xxx
 */
export function parseSlang(md) {
  const out = [];
  let cur = null;
  for (const line of String(md || '').split('\n')) {
    const h = /^##\s+(.+)$/.exec(line.trim());
    if (h) {
      if (cur && cur.word) out.push(cur);
      cur = { word: h[1].trim(), definition: '', usage: '', source: '' };
      continue;
    }
    if (!cur) continue;
    const kv = /^-\s*(释义|用法|出处)[:：]\s*(.+)$/.exec(line.trim());
    if (kv) {
      const [, k, v] = kv;
      if (k === '释义') cur.definition = v.trim().slice(0, MAX_DEFINITION_LEN);
      else if (k === '用法') cur.usage = v.trim();
      else cur.source = v.trim();
    }
  }
  if (cur && cur.word) out.push(cur);
  return out;
}

/** 读某群已确认黑话。缺失/损坏 → 空数组（静默降级）。 */
export function readSlang(personaRoot, gid) {
  const dir = groupDir(personaRoot, gid);
  if (!dir) return [];
  const md = safeRead(join(dir, '黑话.md'));
  if (!md) return [];
  return parseSlang(md).slice(0, MAX_SLANG_PER_GROUP);
}

/** 渲染成给人看的 md。 */
export function renderSlang(list, groupLabel) {
  const lines = [`# 群内黑话（${groupLabel || ''}）`, '', '> 已人工确认，会被注入到她的上下文。', ''];
  for (const s of list) {
    lines.push(`## ${s.word}`);
    if (s.definition) lines.push(`- 释义：${s.definition}`);
    if (s.source) lines.push(`- 出处：${s.source}`);
    if (s.usage) lines.push(`- 用法：${s.usage}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 写候选清单（给人审，不注入）。 */
export function writeCandidates(personaRoot, gid, words, meta = {}) {
  const dir = groupDir(personaRoot, gid);
  if (!dir) return false;
  const lines = [
    `# 候选黑话（待人工确认）`,
    '',
    `> 生成：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    `> 扫描消息：${meta.scanned ?? '?'} 条 ｜ 回看：${meta.lookbackDays ?? '?'} 天`,
    '',
    '**这些是自动挖出来的，未经验证。确认后手动复制到 `黑话.md`。**',
    '',
    '| 词 | 次数 | 样例 | 建议 |',
    '|---|---|---|---|',
  ];
  for (const w of words) {
    // 简单的"建议"启发：常见礼貌语/表情词打低分
    let hint = '待判断';
    if (/^(你好|谢谢|晚安|早安|生日快乐|干嘛)/.test(w.word)) hint = '日常用语，不建议';
    else if (/表情|图片|链接/.test(w.word)) hint = '媒体残渣，忽略';
    else if (/^爱莉/.test(w.word)) hint = '她的名字，不算黑话';
    lines.push(`| ${w.word} | ${w.count} | ${String(w.samples || '').replace(/\|/g, '/')} | ${hint} |`);
  }
  return writeAtomic(join(dir, '候选.md'), lines.join('\n') + '\n');
}

/**
 * 生成「单行常驻注入」文本 —— 无感方案的核心。
 *
 * 目标：40-60 字以内，让她那一轮**直接看到**本群黑话，无需主动查。
 * 成本：约 16-25 token/轮（对比全量 600 token，降 96%）。
 */
export function renderInline(list) {
  if (!list.length) return '';
  const SEP = ' ｜ ';
  const parts = [];
  let len = 0;                                // 已累计的**最终字符串长度**（含分隔符）
  for (const s of list) {
    // ★ 单行注入只取**短释义**（前 8 字），完整释义走 her_slang 工具。
    //   否则 6 条黑话就吃掉 50 字，硬闸会截断到只剩 2 条。
    const shortDef = String(s.definition || s.usage || '?').replace(/^[^，,。.；;]{0,0}/, '').slice(0, 8);
    const one = `${s.word}=${shortDef}`;
    const add = parts.length ? SEP.length + one.length : one.length;
    // ★ 硬闸按最终长度算（含分隔符），不能只算 one.length —— 否则会超
    if (len + add > INLINE_MAX_CHARS) break;
    parts.push(one);
    len += add;
    if (parts.length >= INLINE_TOP_N) break;
  }
  if (!parts.length) return '';
  return parts.join(SEP);
}
