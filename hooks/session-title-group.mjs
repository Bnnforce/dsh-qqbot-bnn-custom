/**
 * session-title-group — QQ 群会话标题自动改为群聊名。
 *
 * 每次进群 pre-step 检查当前 DSH 会话标题；不是群名就通过宿主 sessionTitle 服务改名。
 * 群名来源：{DATA_ROOT}/.qqbot/groups.json（QQBot 维护的群清单）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_ROOT } from '../lib/pack-paths.mjs';

export const name = 'session-title-group';

const GROUPS_FILE = join(DATA_ROOT, '.qqbot', 'groups.json');
let cache = { at: 0, map: new Map() };

function groupNames() {
  if (Date.now() - cache.at < 5000) return cache.map;
  const map = new Map();
  try {
    const j = JSON.parse(readFileSync(GROUPS_FILE, 'utf8')) || {};
    for (const [gid, v] of Object.entries(j)) {
      const n = String(v?.name || '').trim();
      if (gid && n) map.set(gid, n);
    }
  } catch { /* 文件缺失/损坏就跳过 */ }
  cache = { at: Date.now(), map };
  return map;
}

function groupOfAgent(agent) {
  try {
    const ch = agent?.ctx?.get?.('qqChannel');
    const mgr = ch?.manager;
    const rec = mgr?.findByAgent?.(agent) || (agent?.session?.id ? mgr?.findBySessionId?.(agent.session.id) : undefined);
    return rec?.scope === 'group' ? String(rec.peerId || '') : '';
  } catch { return ''; }
}
function titleService(agent, rootCtx) {
  for (const c of [agent?.ctx, rootCtx]) {
    try {
      const svc = c?.get?.('sessionTitle');
      if (svc && typeof svc.rename === 'function') return svc;
    } catch { /* try next */ }
  }
  return null;
}

/** anti-ai-persona V2：DSH assemble context 没有 channel.id，写 sessionId -> groupId 旁路映射。 */
/**
 * 校验群 openid 形状 —— **写入前的最后一道防线**（2026-11-15 新增）。
 *
 * 背景：本函数直接写 persona 的私有文件 session-groups.json，
 *   而 11-15 曾因测试未隔离 DSH_HOME，把 'NEWGID' 这种测试夹具写进了生产。
 *   虽然 mock 已加隔离，但**写入方自己也该挡住非法值**（纵深防御）。
 *
 * 规则与 dsh-qq-memory/src/scope.ts 的 isValidScopeId 同口径的**子集**：
 *   QQ 群 openid 实测是 32 位十六进制（大写）。放宽到什么程度有取舍：
 *   · 太松（只要非空）→ 测试夹具能写进去，就是这次事故
 *   · 太严（只认 32 位 HEX）→ 未来 QQ 换 id 格式会静默丢映射
 *   采用：**32 位十六进制**为唯一合法形状；不符就不写（映射丢失只影响标题，不影响功能）。
 */
const GROUP_OPENID_RE = /^[0-9A-Fa-f]{32}$/;

/**
 * 登记 sessionId → groupId（2026-11-15 起：**优先走 persona 服务的唯一写入口**）。
 *
 * 三条路径（按优先级）：
 *   ① `persona.rememberSessionGroup()` —— 新契约，有校验/清理/原子写
 *   ② 直接写文件 —— fallback（服务不可用时；带同样校验）
 *   ③ 都失败 → 静默跳过（映射丢失只影响会话标题，不影响消息收发）
 */
function rememberSessionGroup(sessionId, groupId, rootCtx) {
  const sid = String(sessionId || '').trim();
  const gid = String(groupId || '').trim();
  if (!sid || !gid) return;
  // ★ 非法 gid 直接不写（防测试夹具/脏数据污染 persona 的映射文件）
  if (!GROUP_OPENID_RE.test(gid)) return;

  // ① 优先走服务（唯一写入口）
  try {
    const svc = rootCtx?.get?.('persona');
    if (svc && typeof svc.rememberSessionGroup === 'function') {
      const r = svc.rememberSessionGroup(sid, gid);
      if (r && r.ok) return;   // 成功即返回，不再走文件
    }
  } catch { /* 服务不可用 → fallback */ }
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'dsh-anti-ai-persona', 'session-groups.json');
    let all = {};
    try { all = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { all = {}; }
    all[sid] = { groupId: gid, updatedAt: Date.now() };
    mkdirSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'dsh-anti-ai-persona'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(all), 'utf8');
    renameSync(tmp, file);
  } catch { /* 映射失败不影响标题 */ }
}

const lookupAt = new Map();
const LOOKUP_TTL = 60_000;
async function resolveGroupName(agent, gid, map) {
  const hit = map.get(gid);
  if (hit) return hit;
  if (Date.now() - (lookupAt.get(gid) || 0) < LOOKUP_TTL) return '';
  lookupAt.set(gid, Date.now());
  try {
    const mgr = agent?.ctx?.get?.('qqChannel')?.manager;
    const ga = mgr?.groupAdmin;
    if (!ga?.getGroupInfo) return '';
    const r = await ga.getGroupInfo(gid);
    const name = String(r?.ok && r?.data?.group_name || '').trim();
    if (name) { map.set(gid, name); return name; }
  } catch { /* 群信息接口失败就保持原标题 */ }
  return '';
}

export async function syncTitle(agent, rootCtx, map = groupNames()) {
  const gid = groupOfAgent(agent);
  if (!gid) return false;
  rememberSessionGroup(agent?.session?.id, String(gid).replace(/^group[_:.-]/iu, ''), rootCtx);
  const title = await resolveGroupName(agent, gid, map);
  if (!title) return false;
  const svc = titleService(agent, rootCtx);
  if (!svc) return false;
  try {
    const current = typeof svc.get === 'function' ? svc.get(agent.session)?.title : undefined;
    if (String(current || '') === title) return false;
    svc.rename(agent.session, title);
    return true;
  } catch { return false; }
}

export async function run(env) {
  const ctx = env?.ctx;
  const rootCtx = env?.ctx;
  if (!ctx?.on) return 'no-ctx';
  const handler = async (payload, next) => {
    const decision = await next();
    try { await syncTitle(payload?.agent, rootCtx); } catch { /* 标题只是装饰，不能影响回复 */ }
    return decision;
  };
  const off = ctx.on('agent/pre-step', handler, { prepend: true });
  try {
    env?.registerDispose?.(() => { try { if (typeof off === 'function') off(); } catch { /* ignore */ } });
  } catch { /* ignore */ }
  return 'ok(group title sync)';
}
export function dispose() { /* registered via ctx */ }
export default { name: 'session-title-group', run, dispose };
