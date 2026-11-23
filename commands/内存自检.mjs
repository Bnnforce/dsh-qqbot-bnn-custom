/**
 * 内存自检 — 补上上游"承诺了但没实现"的 `/memcheck`（2026-11-15）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么是扩展补、而不是等上游：
 *   `@zaofan/dsh-qqbot` 1.12.35 里 `dist/gateway/bootstrap.js:53` 有注释
 *   「给 `/memcheck` 命令注册一个内存快照采集器」，并且**真的**调了
 *   `registerMemStats(...)` 往 `globalThis[Symbol.for('im-qqbot.memstats')]` 挂了采集器 ——
 *   但全包搜不到任何命令/工具去**读**它。采集器写了没人读 ⇒ 这块能力是死的。
 *   （已核对：`grep -rn 'memcheck' dist/` 只命中那一行注释；`dist/commands/` 无此命令。）
 *
 *   上游明确禁止扩展 import 插件 dist，所以这里**不 import**，只读那个公开的全局符号
 *   （与 `im-qqbot.outbound` 同款约定：符号键是扩展与插件唯一都认的通道，官方文档口径）。
 *
 * 输出什么（都是 O(1) 读数，不做遍历、不序列化大对象，随便调）：
 *   ① 上游采集器给的进程内存 + 会话数 + 图片路径缓存条数；
 *   ② 扩展侧 3 个**无界 Map** 的 size —— 没有它们，"谁在涨"永远查不出来：
 *      · `recent-media`：每群最近媒体环形缓冲（按 peer 分桶）
 *      · `session-watch`：子会话监视表 + peer→session 映射
 *      · 中央调度：引擎实例 + 执行器注册表
 *
 * 用法：`/memcheck`（仅主人；数据是进程级的，群友看了也没用且可能泄漏会话规模）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DATA } from '../lib/pack-paths.mjs';

export const name = ['memcheck', '内存自检'];

const MEM_STATS_KEY = Symbol.for('im-qqbot.memstats');
const RECENT_MEDIA_KEY = Symbol.for('qqbot.recent-media.v1');
const WATCHING_KEY = Symbol.for('dsh-qqbot.session-watch.watching');
const PEER_KEY = Symbol.for('dsh-qqbot.session-watch.peerLatest');
const ENGINE_KEY = 'dsh.taskcenter.engine.v1';
const REGISTRY_KEY = 'dsh.taskcenter.registry.v1';

const mb = (n) => `${(Number(n || 0) / 1024 / 1024).toFixed(1)}MB`;

/** 安全读全局 Map 的 size（不存在返回 null，不猜） */
function mapSize(key) {
  try {
    const m = globalThis[key];
    return m && typeof m.size === 'number' ? m.size : null;
  } catch {
    return null;
  }
}

/** 上游采集器（可能没注册；没注册就退回只报扩展侧） */
function upstreamStats() {
  try {
    const fn = globalThis[MEM_STATS_KEY];
    if (typeof fn !== 'function') return null;
    return fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 最近一次 census 落盘时间（若有），用于判断"是不是刚跑过维护" */
function lastCensusAt() {
  try {
    const j = JSON.parse(readFileSync(join(EXT_DATA, 'mem-census.json'), 'utf8'));
    return Number(j?.at ?? 0) || 0;
  } catch {
    return 0;
  }
}

function fmtAgo(ts) {
  if (!ts) return '从未';
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.round(d / 1000)}秒前`;
  if (d < 3600_000) return `${Math.round(d / 60_000)}分钟前`;
  return `${(d / 3600_000).toFixed(1)}小时前`;
}

export default {
  name,
  description: '内存自检：进程内存 + 会话数 + 扩展侧无界表规模（仅主人）',
  usage: '/memcheck',

  async handler(ctx) {
    // 权限：数据是进程级的（会话规模、缓存条数），只给主人
    const caps = ctx?.caps ?? ctx;
    const owners = Array.isArray(caps?.owners) ? caps.owners : [];
    const isOwner = caps?.user?.isOwner ?? caps?.isOwner ?? ctx?.isOwner;
    if (owners.length && isOwner !== true) return { kind: 'text', content: '你还没有该权限哦' };

    const up = upstreamStats();
    const lines = ['## 内存自检', ''];

    if (!up) {
      lines.push('上游采集器未注册（插件未启动完 / 版本不含 mem-stats）');
    } else if (up.error) {
      lines.push(`上游采集器报错：${up.error}`);
    } else {
      lines.push(`- RSS：**${mb(up.rss)}**`);
      lines.push(`- 堆：**${mb(up.heapUsed)}** / ${mb(up.heapTotal)}（外部 ${mb(up.external)}）`);
      if (typeof up.sessions === 'number') lines.push(`- 活跃会话：**${up.sessions}**`);
      if (typeof up.imagePathCache === 'number') lines.push(`- 图片路径缓存：**${up.imagePathCache}** 条`);
    }

    // 扩展侧无界表（这些是"谁在涨"的关键证据）
    const rows = [
      ['recent-media 分桶', mapSize(RECENT_MEDIA_KEY)],
      ['session-watch 监视', mapSize(WATCHING_KEY)],
      ['session-watch peer 映射', mapSize(PEER_KEY)],
      ['中央调度 引擎', mapSize(ENGINE_KEY)],
      ['中央调度 执行器', mapSize(REGISTRY_KEY)],
    ].filter(([, v]) => v !== null);

    if (rows.length) {
      lines.push('', '**扩展侧无界表**');
      for (const [k, v] of rows) lines.push(`- ${k}：**${v}**`);
    } else {
      lines.push('', '扩展侧无界表：未初始化（还没有消息流过）');
    }

    const censusAt = lastCensusAt();
    if (censusAt) lines.push('', `上次落盘快照：${fmtAgo(censusAt)}`);

    // ★ 2026-11-17 修（mock-calendar-and-fortune T7 抓到）：
    //   本命令输出 **markdown**（`## 标题` / `**加粗**`），
    //   但原来返回 `{kind:'text'}` —— QQ 里会把 `##` 和 `**` 原样显示成字面文字。
    //   含 markdown 语法的命令**必须自己调 caps.markdown()**。
    const md = lines.join('\n');
    if (typeof caps?.markdown === 'function') {
      try {
        const ok = await caps.markdown(md);
        if (ok) return '';
      } catch { /* 落到返回文本 */ }
    }
    return { kind: 'text', content: md };
  },
};
