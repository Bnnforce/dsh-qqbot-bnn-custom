/**
 * dirs.mjs — 工作区目录清单 · 首次运行自愈 · 缺失优雅降级
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件（2026-11-20 开源可移植性）
 *
 * 本扩展包要读写一批「工作区数据目录」：
 *   Bot/人格/、Bot/人格/积分、Bot/美图库、Bot/曲库 …
 *
 * 这些目录是**我们的工作区约定**，不是官方要求的。别人装了这个包，
 * 他机器上大概率**一个都没有**。以前的做法是直接拼字符串读 ——
 * 目录不存在时 ENOENT / 空列表 / 功能静默失效，且报错信息让人摸不着头脑。
 *
 * 现在改成三件事：
 *   ① 路径只从这里出（不再各处拼 `${WORKSPACE_ROOT}/Bot/...`）
 *   ② 首次运行自动 mkdir（ensure* 系列），不清空、不覆盖已有的
 *   ③ 读不到时降级：返回空数组/空对象，绝不抛
 *
 * 另：全部目录都可用环境变量重定向，方便用户把数据放到别处（外置卡等）。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 规范：工业化开发手册 §2.2 —— DATA_ROOT（qqbot 数据根）与
 *      WORKSPACE_ROOT（Bot/ 的父目录）绝不能混。以前有 10 处用
 *      `${WORKSPACE_ROOT}/Bot/dshqqbot/...` 去拼 DATA_ROOT，已在本文件收敛。
 */
import { mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, WORKSPACE_ROOT, EXT_DATA } from './pack-paths.mjs';

/* ──────────────────────────────────────────────────────────────
 * 一、环境变量重定向（用户把某个数据目录指到别处时用）
 * ────────────────────────────────────────────────────────────── */

/**
 * 取环境变量覆盖值；空串视为未设置。
 *
 * 支持传入多个变量名（新名在前、旧名在后），兼容历史部署：
 * 旧代码里用的是 DSH_POINTS_ROOT / DSH_SHOP_ROOT / DSH_TASK_CENTER，
 * 新名统一成 BNN_*，但旧名永远保留可用。
 */
function envPath(names, fallback) {
  for (const name of [].concat(names)) {
    const v = String(process.env[name] ?? '').trim();
    if (v) return v;
  }
  return fallback;
}

const BOT = join(WORKSPACE_ROOT, 'Bot');

/* ──────────────────────────────────────────────────────────────
 * 二、目录常量（唯一出口）
 * ────────────────────────────────────────────────────────────── */

/** 人格根：人格卡、分层设定、人生清单、语音样本都在这里。 */
export const PERSONA_ROOT = envPath(['PERSONA_ROOT','BNN_PERSONA_ROOT','DSH_PERSONA_ROOT'], join(BOT, '人格'));

/** 积分账本（谁有多少分、流水）。 */
export const POINTS_ROOT = envPath(['BNN_POINTS_ROOT','DSH_POINTS_ROOT'], join(PERSONA_ROOT, '积分'));

/** 小店（商品定义、订单、库存）。 */
export const SHOP_ROOT = envPath(['BNN_SHOP_ROOT','DSH_SHOP_ROOT'], join(PERSONA_ROOT, '小店'));

/** 语音样本（参考音）。子目录按角色名分。 */
export const VOICE_SAMPLE_ROOT = envPath(['BNN_VOICE_SAMPLE_ROOT','DSH_VOICE_SAMPLE_ROOT'], join(PERSONA_ROOT, '语音样本'));

/** 点歌的歌单缓存（列表 + 检索索引，不含音频本体）。 */
export const PLAYLIST_CACHE_ROOT = envPath(['BNN_PLAYLIST_CACHE_ROOT','DSH_PLAYLIST_CACHE_ROOT'], join(PERSONA_ROOT, '歌单缓存'));

/** 本地曲库（音频文件）。 */
export const SONG_ROOT = envPath(['BNN_SONG_ROOT','DSH_SONG_ROOT'], join(BOT, '曲库'));

/** 美图库（随机图/抽奖配图）。 */
export const IMAGE_ROOT = envPath(['BNN_IMAGE_ROOT','DSH_IMAGE_ROOT'], join(BOT, '美图库'));

/** 事件库（人生事件流）。 */
export const EVENT_ROOT = envPath(['BNN_EVENT_ROOT','DSH_EVENT_ROOT'], join(BOT, '事件库'));

/** 任务中心（tasks.json）。 */
export const TASK_CENTER_ROOT = envPath(['BNN_TASK_CENTER_ROOT','DSH_TASK_CENTER'], join(BOT, '任务中心'));

/** 周报输出目录。 */
export const REPORT_ROOT = envPath(['QQBOT_REPORT_DIR','BNN_REPORT_ROOT'], join(BOT, '周报'));

/* ── 以下属于 qqbot 自己（DATA_ROOT），不要用 WORKSPACE_ROOT 拼 ── */

/** 插件实例数据目录。 */
export const QQBOT_DIR = join(DATA_ROOT, '.qqbot');

/** 群列表（群号 → 群名）。官方维护，我们只读。 */
export const GROUPS_JSON = join(QQBOT_DIR, 'groups.json');

/** 消息历史（按群分文件）。官方维护，我们只读。 */
export const MSG_HISTORY_ROOT = join(QQBOT_DIR, 'msg-history');

/** 扩展共享数据目录（等价 pack-paths 的 EXT_DATA，这里再导出方便一次性 import）。 */
export const DATA_DIR = EXT_DATA;

/* ──────────────────────────────────────────────────────────────
 * 三、清单与自愈
 * ────────────────────────────────────────────────────────────── */

/**
 * 本包期望存在的目录清单。
 *
 * `required: true` = 缺了功能会明显不可用，首次运行必须建。
 * `required: false` = 缺了只是某个可选玩法不可用，用到时再建也行。
 */
export const DIR_MANIFEST = Object.freeze([
  { path: PERSONA_ROOT, required: true, purpose: '人格卡与分层设定' },
  { path: POINTS_ROOT, required: true, purpose: '积分账本' },
  { path: SHOP_ROOT, required: false, purpose: '小店数据' },
  { path: VOICE_SAMPLE_ROOT, required: false, purpose: '语音参考音' },
  { path: PLAYLIST_CACHE_ROOT, required: false, purpose: '点歌歌单缓存' },
  { path: SONG_ROOT, required: false, purpose: '本地曲库' },
  { path: IMAGE_ROOT, required: false, purpose: '美图库' },
  { path: EVENT_ROOT, required: false, purpose: '事件库' },
  { path: TASK_CENTER_ROOT, required: false, purpose: '任务中心' },
  { path: REPORT_ROOT, required: false, purpose: '周报输出' },
  { path: DATA_DIR, required: true, purpose: '扩展共享数据' },
]);

/**
 * 建目录（递归）。已存在直接返回 true，绝不删除/清空。
 *
 * @returns {boolean} 建好（或本来就存在）为 true
 */
export function ensureDir(dir) {
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) return true;
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 按清单批量建目录。
 *
 * @param {{ includeOptional?: boolean }} [opts] includeOptional 默认 false（只建 required）
 * @returns {{ created: string[], existed: string[], failed: string[] }}
 */
export function ensureWorkspaceDirs(opts = {}) {
  const includeOptional = opts.includeOptional === true;
  const created = [];
  const existed = [];
  const failed = [];
  for (const item of DIR_MANIFEST) {
    if (!includeOptional && !item.required) continue;
    const before = existsSync(item.path);
    const ok = ensureDir(item.path);
    if (!ok) failed.push(item.path);
    else (before ? existed : created).push(item.path);
  }
  return { created, existed, failed };
}

/**
 * 诊断：哪些目录还缺。
 *
 * @returns {{ missing: Array<{path:string,required:boolean,purpose:string}>, present: number }}
 */
export function missingDirs() {
  const missing = [];
  let present = 0;
  for (const item of DIR_MANIFEST) {
    let ok = false;
    try {
      ok = existsSync(item.path) && statSync(item.path).isDirectory();
    } catch { /* 当缺失 */ }
    if (ok) present += 1;
    else missing.push({ path: item.path, required: item.required, purpose: item.purpose });
  }
  return { missing, present };
}

/* ──────────────────────────────────────────────────────────────
 * 四、安全读（缺失 = 空，不抛）
 * ────────────────────────────────────────────────────────────── */

/**
 * 列目录。目录不存在或无权限 → 返回空数组（调用方不必 try-catch）。
 *
 * @param {string} dir
 * @param {{ filesOnly?: boolean, exts?: string[] }} [opts]
 * @returns {string[]} 文件名（不含目录前缀）
 */
export function safeList(dir, opts = {}) {
  try {
    const ents = readdirSync(dir, { withFileTypes: true });
    let names = ents.filter((e) => (opts.filesOnly ? e.isFile() : true)).map((e) => e.name);
    if (Array.isArray(opts.exts) && opts.exts.length) {
      const set = new Set(opts.exts.map((x) => String(x).toLowerCase()));
      names = names.filter((n) => {
        const i = n.lastIndexOf('.');
        return i > 0 && set.has(n.slice(i + 1).toLowerCase());
      });
    }
    return names.sort();
  } catch {
    return [];
  }
}

/**
 * 目录里是否有至少一个符合条件的文件。
 *
 * @param {string} dir
 * @param {string[]} [exts]
 * @returns {boolean}
 */
export function hasAnyFile(dir, exts) {
  return safeList(dir, { filesOnly: true, exts }).length > 0;
}

/**
 * 某个目录是否可用（存在且是目录）。不建目录，纯查询。
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function dirAvailable(dir) {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export default {
  PERSONA_ROOT,
  POINTS_ROOT,
  SHOP_ROOT,
  VOICE_SAMPLE_ROOT,
  PLAYLIST_CACHE_ROOT,
  SONG_ROOT,
  IMAGE_ROOT,
  EVENT_ROOT,
  TASK_CENTER_ROOT,
  REPORT_ROOT,
  QQBOT_DIR,
  GROUPS_JSON,
  MSG_HISTORY_ROOT,
  DATA_DIR,
  DIR_MANIFEST,
  ensureDir,
  ensureWorkspaceDirs,
  missingDirs,
  safeList,
  hasAnyFile,
  dirAvailable,
};
