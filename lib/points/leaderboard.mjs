/**
 * points/leaderboard — 本群排行榜（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 隐私红线（硬性）：
 *   ① **只显示本群成员的余额**，不跨群
 *   ② **不显示"在几个群活跃"** —— 那会暴露跨群行为
 *   ③ 可配置关闭（leaderboardEnabled: false）
 *
 * 为什么"只本群"：
 *   积分是全局的，但**榜单按群筛**。这样你看到的是"这个群里谁分多"，
 *   而不是"谁在整个机器人生态里最活跃" —— 后者是隐私泄露。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 从群成员列表筛出有积分的，按余额排序。
 *
 * @param {object} store 积分存储
 * @param {string[]} memberOpenids 本群成员 openid 列表
 * @param {{size?:number, includeZero?:boolean}} opts
 * @returns {Array<{openid:string, name:string, balance:number, rank:number}>}
 */
export function topOfGroup(store, memberOpenids, opts = {}) {
  const cfg = store.cfg;
  const size = Number(opts.size) > 0 ? Number(opts.size) : (Number(cfg.leaderboardSize) || 5);
  const includeZero = opts.includeZero === true;

  const rows = [];
  for (const openid of memberOpenids || []) {
    let d = null;
    try { d = store.read(openid); } catch { d = null; }
    if (!d) continue;
    const balance = Number(d.balance) || 0;
    if (!includeZero && balance <= 0) continue;
    rows.push({
      openid,
      name: String(d.name || '').slice(0, 20) || '（无名）',
      balance,
      totalDays: Number(d.checkin?.totalDays) || 0,
    });
  }

  rows.sort((a, b) => {
    if (b.balance !== a.balance) return b.balance - a.balance;
    return b.totalDays - a.totalDays;
  });

  return rows.slice(0, size).map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * 渲染排行榜文本。
 *
 * @param {Array} rows topOfGroup 的返回
 * @param {{groupName?:string, selfOpenid?:string}} opts
 */
export function renderLeaderboard(rows, opts = {}) {
  const title = opts.groupName ? `## 📊 ${opts.groupName} · 排行榜` : '## 📊 本群排行榜';
  const lines = [title, ''];
  if (!rows || rows.length === 0) {
    lines.push('还没有人有积分。');
    lines.push('');
    lines.push('去 /签到 领第一笔吧。');
    return lines.join('\n');
  }
  const medal = ['🥇', '🥈', '🥉'];
  for (const r of rows) {
    const m = medal[r.rank - 1] || `${r.rank}.`;
    const me = opts.selfOpenid && r.openid === opts.selfOpenid ? '  ← 你' : '';
    lines.push(`${m} ${r.name}　**${r.balance}**${me}`);
  }
  lines.push('');
  lines.push('（只显示本群）');
  return lines.join('\n');
}
