/**
 * owner.mjs — 扩展工具侧的主人判定（共享实现）
 *
 * 2026-11-01 审查 P1-1：上游 `dist/channel-tools.js` 组装扩展工具 env 时，`isOwner`/`owners`
 * 取的是 `mgr.config.owners`（QQBot 设置里根本没有这个顶层字段），而真实白名单在
 * `mgr.config.groupAdmin.owners`（settings 文件 `groupAdmin.owners`）。结果：
 * QQ 会话里扩展工具拿到的 `env.user.isOwner` 恒为 false、`env.owners` 恒为空数组，
 * 于是 `ownerOnlyInQQ()` 在「owners 非空但 isOwner=false」分支上把**主人自己**也拒了
 * （qq_send / session_* / sessions_list / sticker_auto / group_members）。
 *
 * 这里统一按**真实位置**取白名单，并补几个可靠判据：
 *   ① `env.manager.groupAdmin.owners`（settings 里的真实配置）；
 *   ② `env.manager.adminOwners()`（session-manager 提供的兼容方法）；
 *   ③ 最后才回落 `env.owners`（上游字段，正常为空）。
 * 发送者 openid 从 `env.user.openid / env.actorOpenid / env.openid / env.senderOpenid` 里取。
 * 白名单确实未加载时保持 fail-open（避免把主人锁在门外，与各工具原注释一致）。
 */

/** 取当前配置里的主人 openid 列表（尽力而为，异常返回空数组）。 */
export function ownersOf(env) {
  const out = [];
  try {
    const mgr = env?.manager;
    const configured = mgr?.config?.groupAdmin?.owners;
    if (Array.isArray(configured)) out.push(...configured.map(String));
    if (typeof mgr?.adminOwners === 'function') {
      const more = mgr.adminOwners();
      if (Array.isArray(more)) out.push(...more.map(String));
    }
    if (Array.isArray(env?.owners)) out.push(...env.owners.map(String));
    if (Array.isArray(env?.caps?.owners)) out.push(...env.caps.owners.map(String));
  } catch { /* 配置读不到就按未加载处理 */ }
  return [...new Set(out.filter(Boolean))];
}

/** 当前调用者 openid（多路兜底）。 */
export function senderOpenidOf(env) {
  try {
    for (const v of [env?.user?.openid, env?.actorOpenid, env?.openid, env?.senderOpenid, env?.sender?.openid, env?.caps?.user?.openid]) {
      const s = String(v ?? '').trim();
      if (s) return s;
    }
  } catch { /* ignore */ }
  return '';
}

/** 当前调用者是不是主人（白名单未加载时返回 false，由调用方决定 fail-open/closed）。 */
export function isOwnerEnv(env) {
  if (env?.isOwner === true || env?.user?.isOwner === true || env?.caps?.user?.isOwner === true) return true;
  const owners = ownersOf(env);
  if (owners.length === 0) return false;
  const who = senderOpenidOf(env);
  return who !== '' && owners.includes(who);
}

/**
 * 「QQ 会话里只有主人能调用」的统一门禁：
 *   - 非 QQ 会话（无 peer.scope，例如 web/终端）放行；
 *   - 白名单未加载时 fail-open（保持原行为，避免连锁锁死）；
 *   - 其余按真实主人白名单判定。
 * @returns {null | {ok:false, msg:string}} null = 放行
 */
export function ownerOnlyInQQ(env) {
  const scope = String(env?.peer?.scope ?? '');
  if (scope !== 'group' && scope !== 'c2c') return null;
  if (ownersOf(env).length === 0) return null;
  if (isOwnerEnv(env)) return null;
  return { ok: false, msg: '你还没有该权限哦' };
}
