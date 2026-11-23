/**
 * points/members — 取"本群有哪些人"（2026-11-17 修）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么有这个模块（真实 bug 复盘）：
 *
 *   排行榜原来这么拿成员：
 *     await ctx.api(`/v2/groups/${gid}/members?limit=100`)
 *
 *   **这个接口不存在**。官方只提供：
 *     · `getMemberInfo(gid, openid)` —— 单个成员，且 `FEATURE_GATES.getMemberInfo: open === false`（关门）
 *     · `getUserInfo(openid)`      —— 按 openid 查账号名
 *   没有任何"列出群成员"的接口。
 *
 *   后果：api 永远失败 → 成员集只剩点击者自己 → 排行榜显示"还没有人有积分"，
 *   而实际上群里已经有人挣到分了（实测 2 人有档案）。
 *
 * ── 正确做法 ────────────────────────────────────────────────────────────────
 *   用**我们自己的群台账** `.qqbot/msg-history/group_<gid>/*.jsonl`
 *   —— 每条消息都记了 `s`(openid) 和 `n`(昵称)，18 个人现成可用，零 API、零权限。
 *
 *   兜底顺序：
 *     ① 台账（最可靠，无需权限）
 *     ② ctx.api（万一将来官方开放列成员）
 *     ③ 只返回自己（最后兜底，至少不崩）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 默认回看几天台账（越多越全，但越慢；7 天足够覆盖活跃成员）。 */
const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * 从群台账里取成员。
 *
 * @param {string} qqbotRoot qqbot 数据根（含 `.qqbot/`）
 * @param {string} gid 群 openid
 * @param {{days?:number}} [opts]
 * @returns {Array<{openid:string, name:string}>}
 */
export function membersFromLedger(qqbotRoot, gid, opts = {}) {
  const days = Number(opts.days) > 0 ? Number(opts.days) : DEFAULT_LOOKBACK_DAYS;
  const dir = join(String(qqbotRoot || ''), '.qqbot', 'msg-history', `group_${gid}`);
  if (!existsSync(dir)) return [];

  let files = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .slice(-days);
  } catch { return []; }

  const people = new Map();
  for (const f of files) {
    let raw = '';
    try { raw = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const openid = String(j?.s ?? '');
      if (!openid || openid === 'self') continue;      // self = 她自己发的
      const name = String(j?.n ?? '').trim();
      const prev = people.get(openid);
      // 名字取最新一次非空（有人改过昵称时以最近的为准）
      if (!prev || (name && name !== prev.name)) people.set(openid, { openid, name: name || prev?.name || '' });
    }
  }
  return [...people.values()];
}

/**
 * 尽力取本群成员（台账 → ctx.api → 自己）。
 *
 * @param {{qqbotRoot?:string, gid?:string, selfOpenid?:string, api?:Function}} p
 * @returns {Promise<string[]>} openid 列表
 */
export async function memberOpenids(p) {
  const gid = String(p.gid ?? '');
  const self = String(p.selfOpenid ?? '');
  const seen = new Set();

  // ① 台账
  if (p.qqbotRoot && gid) {
    try {
      for (const m of membersFromLedger(p.qqbotRoot, gid)) {
        if (m.openid) seen.add(m.openid);
      }
    } catch { /* ignore */ }
  }

  // ② ctx.api（官方将来若开放列成员，这里会自动生效；失败静默）
  if (seen.size === 0 && typeof p.api === 'function' && gid) {
    try {
      const r = await p.api(`/v2/groups/${gid}/members?limit=100`);
      if (r?.ok && Array.isArray(r.data?.members)) {
        for (const m of r.data.members) {
          const id = String(m?.member_openid || m?.openid || '');
          if (id) seen.add(id);
        }
      }
    } catch { /* 无权限/接口未开 → 忽略 */ }
  }

  // ③ 至少包含自己
  if (self) seen.add(self);
  return [...seen];
}

/**
 * 台账里的 openid → 昵称映射（用于排行榜补名字）。
 * @param {string} qqbotRoot
 * @param {string} gid
 * @returns {Map<string,string>}
 */
export function namesFromLedger(qqbotRoot, gid) {
  const out = new Map();
  for (const m of membersFromLedger(qqbotRoot, gid)) {
    if (m.openid && m.name) out.set(m.openid, m.name);
  }
  return out;
}