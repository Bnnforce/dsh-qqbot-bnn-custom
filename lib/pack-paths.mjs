/**
 * pack-paths.mjs — 扩展包/内置目录共用的路径推导（路径唯一入口）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 目录结构（记住这张图，就不会搞混 DATA_ROOT 和 WORKSPACE_ROOT）
 *
 *   {WORKSPACE_ROOT}/                    ← 工作区（如 /sdcard/DSH 或 ~/dsh）
 *   ├── Bot/
 *   │   ├── 人格/  曲库/  美图库/  事件库/  任务中心/     ← 素材，用 WORKSPACE_ROOT
 *   │   └── dshqqbot/                                    ← 这是 DATA_ROOT（qqbot 数据根）
 *   │       ├── .qqbot/                     插件自己的数据（官方维护）
 *   │       └── .qqbot-extensions/
 *   │           ├── data/                   ← EXT_DATA（扩展共享数据）
 *   │           ├── .state/                 启停状态
 *   │           └── lib/
 *   └── …
 *
 *   {EXT_ROOT} = {DATA_ROOT}/extension-packs/<pack>       ← 本包根目录
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 环境变量（全部可选，生产留空即按目录结构推导）
 *
 *   QQBOT_DATA_ROOT     覆盖 DATA_ROOT（测试隔离/多实例）
 *   BNN_WORKSPACE_ROOT  覆盖 WORKSPACE_ROOT
 *                       ★ 2026-11-20 新增。以前 WORKSPACE_ROOT 只能从 DATA_ROOT
 *                       推导，导致「只改数据根做测试」时 WORKSPACE_ROOT 会跑到
 *                       不该去的地方（实测把目录建到了 {WORKSPACE_ROOT}/Bot）。
 *                       现在两个根可以独立指定，测试必须两个都设。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 变更记录
 *   2026-11-02  数据根支持 QQBOT_DATA_ROOT 覆盖（测试隔离）
 *   2026-11-20  新增 BNN_WORKSPACE_ROOT；WORKSPACE_ROOT 不再只靠 DATA_ROOT 推导；
 *              当 DATA_ROOT 被改道而 WORKSPACE_ROOT 没改时，给出「疑似测试配置」
 *              标记，供 ensure-workspace 等写盘模块判断该不该真建目录。
 */
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包（或内置 .qqbot-extensions）根目录。 */
export const EXT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 是否跑在扩展包布局里（false = 跑在内置 .qqbot-extensions 里）。 */
export const IS_PACK = basename(dirname(EXT_ROOT)) === 'extension-packs';

/** 从模块自身位置推导的数据根（扩展包: 上两级；内置: 上一级）。 */
export const DEFAULT_DATA_ROOT = IS_PACK ? dirname(dirname(EXT_ROOT)) : dirname(EXT_ROOT);

const DATA_OVERRIDE = String(process.env.QQBOT_DATA_ROOT ?? '').trim();
const WS_OVERRIDE = String(process.env.BNN_WORKSPACE_ROOT ?? '').trim();

/**
 * ★ 2026-11-25：优先复用插件写入的权威路径（globalThis 桥）。
 *
 * 为什么需要：本包（扩展包）与插件（dsh-bnnbotbox）各自有一套数据根推导。
 * 插件那套 `shared/paths.js` 的发现链更完整（读 qqbot-settings / 向上查找 / 多候选），
 * 本包只能靠 import.meta.url 推导。两套并存时，同一部署可能算出不同的根 ⇒ 数据分裂。
 *
 * 优先级：环境变量（用户显式改道，最高）> 插件桥（权威结论）> 自身推导（兜底）。
 *
 * ⚠️ 时序：桥由插件 apply() 写入，可能晚于本模块被 import。
 *    读不到桥时回退自身推导 —— 退化为旧行为，绝不比之前差。
 */
const BRIDGE_KEY = Symbol.for('bnnbotbox.paths.v1');

function bridgedDataRoot() {
  try {
    const b = globalThis[BRIDGE_KEY];
    const r = String(b?.qqbotDataRoot ?? '').trim();
    return r ? resolve(r) : '';
  } catch { return ''; }
}

/** qqbot 数据根。 */
export const DATA_ROOT = DATA_OVERRIDE
  ? resolve(DATA_OVERRIDE)
  : (bridgedDataRoot() || DEFAULT_DATA_ROOT);

/** 数据根来源（诊断用：env / bridge / derived）。 */
export const DATA_ROOT_SOURCE = DATA_OVERRIDE
  ? 'env'
  : (bridgedDataRoot() ? 'bridge' : 'derived');

/** 扩展共享数据目录。 */
export const EXT_DATA = join(DATA_ROOT, '.qqbot-extensions', 'data');

/**
 * 工作区根（`Bot/` 的父目录）。
 *
 * 优先级：BNN_WORKSPACE_ROOT > 由 DEFAULT_DATA_ROOT 推导。
 *
 * ⚠️ 推导时用的是 **DEFAULT_DATA_ROOT** 而不是 DATA_ROOT ——
 *   这正是上面的坑：如果按 DATA_ROOT 推导，一旦测试把数据根改到别处，
 *   工作区根就跟着漂移到错误位置。用「包自身位置」推导永远锚在真实布局上，
 *   想改工作区根请显式设 BNN_WORKSPACE_ROOT。
 */
export const WORKSPACE_ROOT = WS_OVERRIDE
  ? resolve(WS_OVERRIDE)
  : dirname(dirname(DEFAULT_DATA_ROOT));

/** 数据根是否被环境变量改道。 */
export const DATA_ROOT_OVERRIDDEN = Boolean(DATA_OVERRIDE);

/** 工作区根是否被环境变量改道。 */
export const WORKSPACE_ROOT_OVERRIDDEN = Boolean(WS_OVERRIDE);

/**
 * 是否处于「半改道」状态：数据根改了、工作区根没改。
 *
 * 这种组合通常是测试忘了设 BNN_WORKSPACE_ROOT —— 此时若还去真实工作区
 * 建目录/写文件就会污染生产。写盘模块（如 ensure-workspace）应据此降级为只读。
 */
export const PARTIAL_OVERRIDE = DATA_ROOT_OVERRIDDEN && !WORKSPACE_ROOT_OVERRIDDEN;

export default {
  EXT_ROOT,
  IS_PACK,
  DATA_ROOT,
  DEFAULT_DATA_ROOT,
  EXT_DATA,
  WORKSPACE_ROOT,
  DATA_ROOT_OVERRIDDEN,
  WORKSPACE_ROOT_OVERRIDDEN,
  PARTIAL_OVERRIDE,
};
