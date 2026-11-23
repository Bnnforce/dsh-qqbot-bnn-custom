/**
 * persona-path — 统一的人格数据路径解析（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块（工业化：一处实现，处处一致）
 *
 * 问题（实测发现）：三个工具取人格的方式完全不同 ——
 *   · her_taste：从群状态读 groupState().persona  ✅ 正确
 *   · work_fact：直接用全局 PERSONA_ROOT          ❌ 不分人格
 *   · her_slang：直接用全局 PERSONA_ROOT          ❌ 不分人格
 *
 * 后果：群 688E3805 已切到「比安安」，但它仍在读「爱莉希雅」的事实库/黑话本。
 *   本来是"只有一个人格所以不炸"，现在实际已经两个人格混跑 ⇒ 必须统一。
 *
 * 设计原则：
 *   ① **单一实现**：所有需要"当前群是哪个的人格"的地方，都调这里
 *   ② **失败降级**：读不到群状态 → 回落默认人格（不抛错、不阻塞）
 *   ③ **不缓存**：人格随时可切，每轮重读（成本可忽略，就是个 JSON 文件）
 *   ④ **纯函数**：不写盘、不改状态，只读
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { join } from 'node:path';
import { PERSONA_ROOT, defaultPersona, normalizePersonaName, readConfig } from './persona-store.mjs';
import { loadState, groupState } from './persona-switch.mjs';

/**
 * 从 env 里取群/私聊 id。
 * 兼容三种字段形状（不同工具拿到的 env 不完全一样，实测过）。
 */
export function peerIdOf(env) {
  const p = env?.peer || {};
  return String(
    p.peerId || p.groupId || env?.peerId || env?.groupId || ''
  ).trim();
}

/** peer 是否群聊（没有 peer 信息时按群处理，因为 QQ 扩展工具绝大多数场景是群）。 */
export function isGroupPeer(env) {
  const p = env?.peer || {};
  const scope = String(p.scope || env?.peerScope || '').trim();
  // scope 缺失 → 未知，按群处理（保守：群路径更具体）
  if (!scope) return true;
  return scope === 'group';
}

/**
 * 取当前会话的人格名。
 *
 * 优先级：
 *   ① 群绑定的人格（persona-groups.json 里该群的 persona 字段）
 *   ② 默认人格（persona-config.json 的 defaultPersona）
 *   ③ 空串（调用方自行处理）
 *
 * ⚠️ 注意 `persona: ""` 是"未显式设置"，不是"人格为空" ⇒ 要回落默认。
 */
export function currentPersonaOf(env) {
  try {
    const gid = peerIdOf(env);
    if (gid && isGroupPeer(env)) {
      const st = loadState();
      const g = groupState(st, gid);
      const raw = String(g?.persona ?? '').trim();
      // 归一化（可能是文件名、别名、大小写不同）
      const name = raw ? normalizePersonaName(raw, readConfig()) : '';
      if (name) return name;
    }
  } catch { /* 读状态失败 → 回落默认 */ }

  try {
    const d = defaultPersona();
    if (d?.name) return d.name;
  } catch { /* ignore */ }
  return '';
}

/**
 * 取某类人格数据的根目录。
 *
 * @param {string} subdir  「事实库」/「人生清单」/「黑话本」/「角色卡」…
 * @param {object} env     工具拿到的 env（含 peer）
 * @returns {string}        `<PERSONA_ROOT>/<subdir>/<当前人格>`（未找到人格时返回全局 `<PERSONA_ROOT>/<subdir>`）
 *
 * ⚠️ 关键：**返回的是"该人格的目录"**，不是全局目录。
 *   存量数据还没按人格分目录时，调用方应先试人格目录、再回落全局（见 resolveDataDir）。
 */
export function personaDataDir(subdir, env) {
  const name = currentPersonaOf(env);
  if (!name) return join(PERSONA_ROOT, subdir);
  return join(PERSONA_ROOT, subdir, name);
}

/**
 * 取人格数据目录，**带存量兼容**：
 *   ① 先试 `<PERSONA_ROOT>/<subdir>/<persona>/`（新结构，按人格分）
 *   ② 不存在 → 回落 `<PERSONA_ROOT>/<subdir>/`（旧结构，全局单一）
 *
 * 这样：迁移期间旧数据仍可读，新数据按人格分。
 *
 * @param {string} subdir
 * @param {object} env
 * @param {(p:string)=>boolean} existsFn  传入 existsSync（避免本模块直接依赖 fs）
 */
export function resolveDataDir(subdir, env, existsFn) {
  const name = currentPersonaOf(env);
  if (name && typeof existsFn === 'function') {
    const perPersona = join(PERSONA_ROOT, subdir, name);
    if (existsFn(perPersona)) return perPersona;
  }
  return join(PERSONA_ROOT, subdir);
}

/** 取当前人格的角色卡路径。 */
export function personaCardPath(env) {
  const name = currentPersonaOf(env);
  if (!name) return '';
  return join(PERSONA_ROOT, '角色卡', `${name}.md`);
}

export { PERSONA_ROOT };
