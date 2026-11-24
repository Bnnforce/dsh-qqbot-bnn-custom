/**
 * birthday-auto — 每天按群检查生日档，给每个有生日的群发一次 AI 祝福
 *
 * 数据源：{dataRoot}/.qqbot-extensions/data/group-memory/groups/<gid>/events/birthdays/
 * 规则：一个群一个生日档；只查本群；每天 announceHour 后每个群最多触发一次。
 * 发送：caps.wakeTo('group', gid, 生日提醒) 唤醒该群 AI 发祝福。
 * 待发标记：{dataRoot}/.qqbot-extensions/data/birthday-pending/<gid>.json（per-group，带 TTL；
 *   由 outbound/05-birthday-at-all 消费后补 `<@all>`，过期标记由本 hook 下一次 tick 清掉）。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultPersona } from '../lib/io/persona-store.mjs';
import { currentPersonaOf } from '../lib/io/persona-path.mjs';
import { registerWithFallback } from './zz-central-scheduler.mjs';

const TZ = 'Asia/Shanghai';
const DEFAULT_HOUR = 9;
const STATE_NAME = 'birthday-auto.json';
const CONFIG_NAME = 'birthday-config.json';
/**
 * ★ 2026-11-05 P1 修复：待发标记从「单个全局文件」改为「按群一个文件」。
 *   目录：{dataRoot}/.qqbot-extensions/data/birthday-pending/<gid>.json
 *   旧的单文件 `birthday-pending.json` 仍可被 outbound/05 兜底消费（向后兼容）。
 */
const PENDING_DIR_NAME = 'birthday-pending';
const PENDING_LEGACY_NAME = 'birthday-pending.json';
/** 标记 TTL：wakeTo 成功不代表 agent 会回复（可能沉默/只发媒体），到期必须失效。 */
const PENDING_TTL_MS = 5 * 60 * 1000;
/** `.tmp-*` 残留超过这个时长才清（正在写盘的临时文件不能误删）。 */
const PENDING_TMP_STALE_MS = 10 * 60 * 1000;
/** 降级用的原节律（仅当任务中心没接管时生效）。与 tasks.json 的 everyMs 保持一致：5 分钟。 */
const BIRTHDAY_FALLBACK_MS = 300_000;

/**
 * 取某个群「实际生效的人格名」。
 *
 * ★ 2026-11-24 修（P1，真 bug）：
 *   原来这里只取**全局默认人格** defaultPersona()，然后在遍历所有群的循环外
 *   算一次 selfName。后果：
 *   某群已切到「比安安」，而今天是比安安生日 → 代码拿默认人格「爱莉希雅」去比
 *   ⇒ 判不出「她自己生日」，输出第三人称「祝 XX 生日快乐」；反过来默认人格
 *   生日时，切了人格的群也会误判成「她自己」。
 *   现在按群取：群显式人格 → 默认人格。
 *
 * @param {string} gid
 */
function personaNameOfGroup(gid) {
  try {
    const name = currentPersonaOf({ peer: { peerId: String(gid || ''), scope: 'group' } });
    if (name) return name;
  } catch { /* 回落默认 */ }
  try { return defaultPersona()?.name || '当前人格'; } catch { return '当前人格'; }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) ?? fallback; } catch { return fallback; }
}
/**
 * 原子写 JSON：同目录临时文件 → rename 覆盖（开发规则 §四.3）。
 * 旧实现直接 `writeFileSync` 覆盖：birthday-auto 轮询与出站层读取并发时，
 * 可能读到半截 JSON（然后 JSON.parse 失败 = 标记丢失）。
 */
let tmpSeq = 0;
function writeJson(file, value) {
  let tmp = '';
  try {
    mkdirSync(dirname(file), { recursive: true });
    tmp = `${file}.tmp-${process.pid}-${(tmpSeq += 1).toString(36)}-${Date.now().toString(36)}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    if (tmp) { try { unlinkSync(tmp); } catch { /* ignore */ } }
    return false;
  }
}
function dataRootOf(env) {
  return String(env?.dataRoot || env?.caps?.dataRoot || '').trim();
}
function configOf(root) {
  return readJson(join(root, '.qqbot-extensions', 'data', CONFIG_NAME), {});
}
function zonedParts(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}
function groupsRoot(root) {
  return join(root, '.qqbot-extensions', 'data', 'group-memory', 'groups');
}
/** `{dataRoot}/.qqbot-extensions/data`（待发标记与状态文件的根）。 */
function extDataDir(root) {
  return join(root, '.qqbot-extensions', 'data');
}
/** gid 会拼进文件名：只留字母数字/下划线/横线，防止路径穿越（开发规则 §六.3）。 */
function safeGid(gid) {
  const s = String(gid ?? '').trim();
  if (!s) return '';
  const safe = s.replace(/[^0-9A-Za-z_-]+/g, '_');
  return safe && safe !== '.' && safe !== '..' ? safe : '';
}
function pendingDir(root) {
  return join(extDataDir(root), PENDING_DIR_NAME);
}
/** 本群的待发标记路径；gid 非法返回空串（调用方据此跳过）。 */
function pendingFileOf(root, gid) {
  const safe = safeGid(gid);
  return safe ? join(pendingDir(root), `${safe}.json`) : '';
}
/** 标记是否过期：优先 expiresAt；旧标记没有该字段时按 at + TTL 兜底。 */
function isPendingExpired(pending, now = Date.now()) {
  const expiresAt = Number(pending?.expiresAt ?? 0);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return now > expiresAt;
  const at = Number(pending?.at ?? 0);
  if (!Number.isFinite(at) || at <= 0) return true;
  return now - at > PENDING_TTL_MS;
}

/**
 * 写「待发标记」—— 2026-11-05 新增；同日 P1 修复改为 per-group。
 *
 * 为什么要这个文件：`@全体成员`(`<@all>`) 必须由**出站层**加才可靠，
 * 不能指望模型每次都照做。这里在 wakeTo 之前落一个标记，
 * 由 `outbound/05-birthday-at-all.mjs` 消费后给正文开头补 `<@all>`（用完即清）。
 *
 * 为什么按群拆文件：多群同一天生日时，单文件会被后写的群覆盖，
 * 前一个群的回复匹配不到 → 丢 `@全体`；后一个群失败还会把前一个群的标记一起清掉。
 * 为什么带 expiresAt：wakeTo 成功不代表 agent 会回复（可能沉默/只发媒体），
 * 标记必须有 TTL，过期后由下一次 tick 清掉，绝不能污染之后的普通回复。
 */
function writePending(root, gid, people) {
  const file = pendingFileOf(root, gid);
  if (!file) return false;
  const now = Date.now();
  return writeJson(file, {
    gid: String(gid),
    at: now,
    expiresAt: now + PENDING_TTL_MS,
    people,
  });
}

/** 清掉**本群**的待发标记（wakeTo 失败时必须清，否则窗口内别的消息会被误加 `@全体`）。 */
function clearPending(root, gid) {
  const file = pendingFileOf(root, gid);
  if (!file) return;
  try { unlinkSync(file); } catch { /* 不存在/已被消费：忽略 */ }
}

/** 删掉过期的 `.tmp-*` 残留（只有原子写被断电打断才会留下）。 */
function sweepStaleTmp(file) {
  try {
    if (Date.now() - statSync(file).mtimeMs > PENDING_TMP_STALE_MS) unlinkSync(file);
  } catch { /* ignore */ }
}

/**
 * 清理过期标记（每个 tick 顺手跑一次，节律即任务中心的 5 分钟）。
 * 覆盖「wakeTo 成功但 agent 沉默/只发媒体」：没有回复来消费时，标记到期即被清掉，
 * 不会残留到污染之后任意一条普通回复。
 */
function sweepExpiredPending(root) {
  const dir = pendingDir(root);
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (name.includes('.tmp-')) { sweepStaleTmp(file); continue; }
      if (!/\.json$/i.test(name)) continue;
      const pending = readJson(file, null);
      if (!pending || isPendingExpired(pending)) {
        try { unlinkSync(file); } catch { /* ignore */ }
      }
    }
  } catch { /* 目录不存在：没有标记要清 */ }

  // 兼容旧版单文件：过期/空壳就清掉；未过期且带 gid 的留给 05 消费（读旧 + 删旧）。
  const legacy = join(extDataDir(root), PENDING_LEGACY_NAME);
  const old = readJson(legacy, null);
  if (old && (isPendingExpired(old) || !old.gid)) {
    try { unlinkSync(legacy); } catch { /* ignore */ }
  }
}
function groupDirs(root) {
  try {
    return readdirSync(groupsRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return []; }
}
function birthdayDir(root, gid) {
  return join(groupsRoot(root), gid, 'events', 'birthdays');
}
function personOf(text, filename) {
  const m = /- 人物：([^\n]+)/.exec(text);
  return (m?.[1] || filename.replace(/^\d{2}-\d{2}-/, '').replace(/\.md$/i, ''))
    .trim().replace(/[。.!！\s]+$/, '');
}
function todayBirthdays(root, gid, ymd) {
  const dir = birthdayDir(root, gid);
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!/\.md$/i.test(name)) continue;
      const text = readFileSync(join(dir, name), 'utf8');
      const b = /- 生日：每年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
      if (!b) continue;
      if (Number(b[1]) !== ymd.m || Number(b[2]) !== ymd.d) continue;
      out.push(personOf(text, name));
    }
  } catch { /* no dir */ }
  return out;
}

/**
 * 组装「生日提醒」文案（2026-11-05 新增，区分三种情况）。
 *
 * 背景（主人要求）：
 *   「要祝自己生日，然后要以自己的口吻怎么祝自己生日许愿望」
 *   ⇒ 她生日当天不能用「祝爱莉希雅生日快乐」这种第三人称的傻话，
 *     要用**第一人称**给自己庆生，并**许一个生日愿望**。
 *
 * 三种形态：
 *   ① 只有别人          → 常规祝福（只祝别人）
 *   ② 只有她自己        → 第一人称自祝 + 许愿
 *   ③ 她和别人同天      → 先祝别人，再顺带提自己今天生日并许愿
 *
 * `@全体成员` 由出站层强制加（`outbound/05-birthday-at-all.mjs`），
 * 所以这里统一要求「不要 @ 任何人」，避免模型自己再 @ 一次寿星。
 */
function birthdayPrompt(ymd, others, selfToday, selfName) {
  const who = selfName || '当前人格';
  const head = `【生日提醒·插件】今天是 ${ymd.m} 月 ${ymd.d} 日，`;
  const tail = '不要 @ 任何人（系统会自动 @ 全体成员），不要提系统、记忆、规则，也不要解释为什么发。';
  const othersText = others.join('、');

  if (selfToday && others.length > 0) {
    return `${head}本群生日：${othersText}；今天也是你自己（${who}）的生日。`
      + `请用${who}的口吻发一条简短祝福：先祝${othersText}生日快乐，`
      + '再顺带提一句今天也是你自己的生日，并**以第一人称（我）许一个生日愿望**；'
      + `说自己的部分只能用第一人称，绝对不要用第三人称说「祝${who}生日快乐」。`
      + tail;
  }
  if (selfToday) {
    return `${head}**今天是你自己的生日**。`
      + `请用${who}的口吻发一条简短的生日自祝：像真的在给自己过生日那样，`
      + '**以第一人称（我）许一个生日愿望**，可以带一点傲娇/自恋/俏皮；'
      + `绝对不要用第三人称说「祝${who}生日快乐」这种话。`
      + tail;
  }
  return `${head}本群生日：${othersText}。`
    + `请用${who}的语气发一句简短的生日祝福；只发祝福，`
    + tail;
}

/** 可单测：到点后逐群检查；每个群当天只祝福一次。 */
export async function checkAndAnnounce(env, now = new Date()) {
  const root = dataRootOf(env);
  if (!root) return { ok: false, reason: 'no-data-root', results: [] };
  // ★ P1 修复：每个 tick 先扫过期标记 —— wakeTo 成功但 agent 沉默/只发媒体时，
  //   标记不会有回复来消费，必须靠这里到期清掉；不然后续普通回复会被误加 @全体。
  sweepExpiredPending(root);
  const cfg = configOf(root);
  const hour = Number.isFinite(Number(cfg.announceHour)) ? Number(cfg.announceHour) : DEFAULT_HOUR;
  const ymd = zonedParts(now);
  if (ymd.h < hour) return { ok: false, reason: 'not-time', results: [] };

  const caps = env?.caps ?? env;
  if (typeof caps?.wakeTo !== 'function') return { ok: false, reason: 'no-wakeTo', results: [] };

  const stateFile = join(root, '.qqbot-extensions', 'data', STATE_NAME);
  const state = readJson(stateFile, {});
  if (!state.last || typeof state.last !== 'object') state.last = {};
  const date = `${ymd.y}-${String(ymd.m).padStart(2, '0')}-${String(ymd.d).padStart(2, '0')}`;
  const results = [];
  let sent = 0;

  for (const gid of groupDirs(root)) {
    // ★ 按群取人格（不再用循环外的全局默认值）
    const selfName = String(personaNameOfGroup(gid) ?? '').trim();
    const allPeople = todayBirthdays(root, gid, ymd);
    if (!allPeople.length) continue;
    // ★ 2026-11-05：区分「别人」与「她自己」。
    //   她生日当天要**第一人称自祝 + 许愿**，绝不能说「祝爱莉希雅生日快乐」这种第三人称的傻话。
    const others = allPeople.filter((p) => String(p ?? '').trim() !== selfName);
    const selfToday = allPeople.length > others.length;
    const key = `${gid}:${date}`;
    if (state.last[key]) {
      results.push({ gid, people: others, selfToday, status: 'already' });
      continue;
    }
    // ★ 2026-11-05：`@全体成员` 由出站层强制加（见 outbound/05-birthday-at-all.mjs），
    //   所以这里明确让模型「不要 @ 任何人」，避免它自己再 @ 一次寿星。
    const msg = birthdayPrompt(ymd, others, selfToday, selfName);
    // 落待发标记：出站层据此给这条回复开头补 `<@all>`
    writePending(root, gid, allPeople);
    let ok = false;
    try { const r = await caps.wakeTo('group', gid, msg); ok = r !== false; } catch { ok = false; }
    // 只清本群：绝不能把别的群刚写好的标记一起清掉。
    if (!ok) clearPending(root, gid);
    if (ok) {
      state.last[key] = new Date().toISOString();
      sent += 1;
      results.push({ gid, people: others, selfToday, status: 'sent' });
    } else {
      results.push({ gid, people: others, selfToday, status: 'wake-failed' });
    }
  }
  if (sent) writeJson(stateFile, state);
  return { ok: sent > 0, reason: sent ? 'sent' : (results.length ? 'none-sent' : 'no-birthday'), results };
}

export async function run(env) {
  const tick = async () => {
    try { await checkAndAnnounce(env); } catch { /* ignore */ }
  };

  // ① 启动即检查一次：重启后若已过 announceHour 且今天没发过，立刻补上（**不可删**）
  await tick();

  // ★ 2026-11-05 阶段 3 收编：节律交给中央调度器（tasks.json 的 `ext-birthday-auto`）。
  //   节律**保持 300000（5 分钟）不降频** —— 这是**日界任务**（每天 announceHour 之后发一次），
  //   轮询精度直接决定祝福的延迟：5 分钟 → 最多迟到 5 分钟；若拉到 1 小时，9:00 的祝福可能 10:00 才发。
  //   它自己按 `state.last[gid:date]` 做按日去重，所以多扫几次也不会重复发。
  registerWithFallback('birthday-auto', () => tick(), {
    env, fallbackMs: BIRTHDAY_FALLBACK_MS, label: 'birthday-auto', meta: { id: 'ext-birthday-auto' },
  });
}

export function dispose() {
  // 2026-11-05 阶段 3 收编后本 hook 不再自己持有定时器：
  //   · 正常由 `registerWithFallback` 把降级定时器登记进 registerDispose；
  //   · 引擎侧由 `zz-central-scheduler` 统一清理。
  // 保留导出以满足 QQBot 契约（已无 timer 可清）。
}

export default { name: 'birthday-auto', run, dispose };
