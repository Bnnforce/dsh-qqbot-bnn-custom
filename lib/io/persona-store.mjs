/**
 * persona-store — 人格/规则目录的唯一读取层。
 *
 * 结构：
 *   人格/规则/*.md       按文件名排序全部读取
 *   人格/角色卡/*.md     文件名去 .md = 人格 ID / 卡片名
 *   人格/persona-config.json
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
// ★ 2026-11-20 修 P0（审计：人格根双真源）：
//   原来这里自己算 `join(DATA_ROOT, '..', '人格')` —— 与 lib/dirs.mjs 的 PERSONA_ROOT
//   是**两套推导**，且不认 BNN_PERSONA_ROOT / DSH_PERSONA_ROOT 覆盖。
//   后果：用户把人格目录重定向后，「建目录/巡检」走 dirs.mjs（新路径），
//   「读人格卡」走这里（旧路径）→ 人格静默回落到默认。现统一到 dirs.mjs 单一真源。
import { PERSONA_ROOT } from '../dirs.mjs';

export { PERSONA_ROOT };
export const CONFIG_FILE = join(PERSONA_ROOT, 'persona-config.json');
export const REQUIRED_RULE_MARKERS = ['P0 ', 'P0M ', 'P0O ', 'P0C ', 'P0R ', 'P0G ', 'P0T ', 'P1Q '];
const SECURITY_MARKERS = REQUIRED_RULE_MARKERS;
const PLACEHOLDER_MARKERS = ['第二人格占位', '请把下面的内容替换'];

function safeDir(name, fallback) {
  const raw = String(name || fallback || '').trim() || fallback;
  const abs = resolve(PERSONA_ROOT, raw);
  if (abs !== PERSONA_ROOT && !abs.startsWith(PERSONA_ROOT + sep)) return join(PERSONA_ROOT, fallback);
  return abs;
}
export function readConfig() {
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
    return {
      version: 2,
      // ★ 2026-11-23 修：原来兜底写死 '爱莉希雅'（2026-11-02 的默认人格），
      //   后果：全新环境没有 persona-config.json 时，readConfig() 会返回一个**并不存在**的人格名，
      //   使 botplay/persona-switch 的「角色卡目录里没有可用人格」保护失效，
      //   还会把使用者的角色名硬编码进开源代码。
      //   现在：配置 → 空串（由 defaultPersona()/scanPersonaFolder 的调用方显式降级）。
      defaultPersona: String(j.defaultPersona || '').trim(),
      rulesDir: safeDir(j.rulesDir, '规则'),
      personasDir: safeDir(j.personasDir, '角色卡'),
    };
  } catch {
    return { version: 2, defaultPersona: '', rulesDir: join(PERSONA_ROOT, '规则'), personasDir: join(PERSONA_ROOT, '角色卡') };
  }
}
function mdFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name))
      .map((e) => join(dir, e.name))
      .sort((a, b) => a.localeCompare(b, 'zh'));
  } catch { return []; }
}
export function listRuleFiles(config = readConfig()) {
  return mdFiles(config.rulesDir);
}
export function readRules(config = readConfig()) {
  const files = listRuleFiles(config);
  const parts = [];
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (text) parts.push(text);
    } catch { /* skip */ }
  }
  return { text: parts.join('\n\n---\n\n').trim(), files };
}
export function personaNameOf(file) {
  return basename(String(file || '')).replace(/\.md$/i, '').trim();
}
export function validatePersonaText(text) {
  const t = String(text || '').trim();
  if (t.length < 300) return { ok: false, error: `人格过短(${t.length} 字)` };
  if (PLACEHOLDER_MARKERS.some((m) => t.includes(m))) return { ok: false, error: '还是占位模板，先填内容' };
  const bad = SECURITY_MARKERS.filter((m) => t.includes(m));
  if (bad.length) return { ok: false, error: '人格层不应包含安全标记 ' + bad.join(',') };
  return { ok: true };
}
export function listPersonas(config = readConfig()) {
  const out = [];
  for (const file of mdFiles(config.personasDir)) {
    const name = personaNameOf(file);
    let text = '';
    try { text = readFileSync(file, 'utf8').trim(); } catch { /* skip */ }
    const v = validatePersonaText(text);
    out.push({ name, file, text, valid: v.ok, error: v.ok ? '' : v.error });
  }
  return out;
}
export function resolvePersona(nameOrFile, config = readConfig()) {
  const raw = String(nameOrFile || '').trim();
  if (!raw) return null;
  const name = raw.replace(/\.md$/i, '');
  const all = listPersonas(config);
  return all.find((p) => p.name === name) || null;
}
export function defaultPersona(config = readConfig()) {
  const all = listPersonas(config).filter((p) => p.valid);
  if (!all.length) return null;
  return all.find((p) => p.name === config.defaultPersona) || all[0];
}
export function listPersonaChoices(config = readConfig()) {
  return listPersonas(config).filter((p) => p.valid);
}
export function normalizePersonaName(name, config = readConfig()) {
  const raw = String(name || '').trim();
  const choices = listPersonaChoices(config);
  const def = defaultPersona(config);
  if (raw === '1' || !raw) return def?.name || '';
  if (raw === '2') return (choices.find((p) => p.name !== def?.name) || def)?.name || '';
  if (choices.some((p) => p.name === raw.replace(/\.md$/i, ''))) return raw.replace(/\.md$/i, '');
  return def?.name || '';
}
export function scanPersonaFolder(config = readConfig()) {
  const rules = readRules(config);
  const all = listPersonas(config);
  const choices = all.filter((p) => p.valid);
  const invalid = all.filter((p) => !p.valid);
  const def = defaultPersona(config);
  return { config, rules, all, choices, invalid, defaultPersona: def };
}

export function composePrompt(personaName, config = readConfig()) {
  const rules = readRules(config);
  if (!rules.text) return { ok: false, reason: '规则目录为空或不可读', rulesCount: 0 };
  const missing = REQUIRED_RULE_MARKERS.filter((m) => !rules.text.includes(m));
  if (missing.length) return { ok: false, reason: '规则缺少安全标记 ' + missing.join(','), rulesCount: rules.files.length };
  const name = normalizePersonaName(personaName, config);
  const persona = resolvePersona(name, config);
  if (!persona) return { ok: false, reason: '没有可用人格卡', rulesCount: rules.files.length };
  if (!persona.valid) return { ok: false, reason: persona.error || '人格无效', rulesCount: rules.files.length };
  const text = [rules.text, '---', persona.text].join('\n\n').trim();
  if (text.length < 800) return { ok: false, reason: `组合过短(${text.length} 字)`, rulesCount: rules.files.length };
  // ★ 2026-11-16 修（「改了角色卡但会话不更新」的根因）：
  //
  //   问题链路：角色卡改 → groupPrompt 更新（同步正常）→ 但**会话里还是旧人格**。
  //   根因：qqbot 插件给 groupPrompt 做去重时，指纹只取**前 60 个字符**：
  //       const rulesFp = rules.trim().slice(0, 60);
  //   人格卡正文在 groupPrompt 的中后段（第 60 字之后），改那里**指纹不变** →
  //   插件认定"内容没变" → 永不重注 → 模型一直拿着会话启动时那份旧人格。
  //   （实测：§3.6「被问到喜好就调 her_taste」写了但模型从没调过工具，就是这条链路断的。）
  //
  //   修法：在群守则**最开头**加一行内容指纹（整段 prompt 的哈希）。
  //   任何一处改动都会改变哈希 → 前 60 字变化 → 插件判定"内容变了" → 自动重注一次。
  //   这行本身对模型无害（可读的版本标记），且不影响人格内容。
  const fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 8);
  const stampedText = `<!-- persona-fp:${fingerprint} rules:${rules.files.length} persona:${persona.name} -->\n${text}`;
  return { ok: true, text: stampedText, personaName: persona.name, personaFile: persona.file, rulesCount: rules.files.length, fingerprint };
}
