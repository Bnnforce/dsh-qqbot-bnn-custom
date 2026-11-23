/**
 * aaa-command-owner-gate — 插件自带斜杠命令只允许 主人 本人执行
 *
 * 2026-10-25 主人要求：内置指令做人员校验，只看我的回复执行。
 * - 只拦插件 buildCommandList() 的自带命令；扩展指令（/来张图、/随心配、/周报、/猜拳…）不拦。
 * - 非主人发内置命令：直接 annihilate，不执行、不回显。
 * - P0O 认证用户也不算本人：ctx.isOwner 只认真实 owner 白名单。
 */
export const name = 'command-owner-gate';

const BUILTIN = new Set([
  // dist/commands/buildCommandList() 的实际名字/别名
  'bot-reset', 'bot-clear', 'bot-new', 'new', 'preset', 'presets',
  'bot-model', 'model', 'bot-status', 'outmode',
  'permission', 'perm', '权限', '答', 'ans', 'botplay', 'inject',
  'bot-restart', 'bot-exit', 'bot-ping', 'bot-version', 'bot-stop',
  'tools-reload', 'bot-help',
  // 扩展命令里属于会话管理/跨会话权限的，也只允许主人
  '会话列表', 'sessionlist', 'sessions',
  '唤醒', 'wake', 'huanxing',
  '子会话', 'subsession',
]);

function commandName(text) {
  let s = String(text ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trimStart();
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s
      .replace(/^★主人\s*/u, '')
      .replace(/^(?:<@[^>]+>|@[^\s]+)\s*/u, '')
      .replace(/^／/, '/')
      .trimStart();
    if (s === before) break;
  }
  if (!s.startsWith('/')) return '';
  const m = /^\/([^\s/]+)/.exec(s);
  return m ? m[1].toLowerCase() : '';
}

export async function onInbound(ctx, next) {
  try {
    const scope = String(ctx?.scope ?? '');
    if (scope !== 'group' && scope !== 'c2c') return next();
    const name = commandName(ctx?.text);
    if (!name) return next();
    if (!BUILTIN.has(name)) return next(); // 扩展指令不拦
    if (ctx?.isOwner === true) return next(); // 只放行 主人 本人

    try {
      await ctx?.annihilate?.({ reason: `非主人使用内置指令 /${name}`, ownerAck: false });
    } catch { /* ignore */ }
    return; // 不执行、不进 AI、不回复
  } catch { /* ignore */ }
  return next();
}
