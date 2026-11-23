/** 人格切换卡：动态读取 人格/角色卡/*.md，文件名去 .md 作为人格 ID。 */
import { loadState, saveState, groupState, cooldownLeft, cooldownText, overlayReady } from '../lib/io/persona-switch.mjs';
import { listPersonaChoices, normalizePersonaName, composePrompt, readConfig, defaultPersona, scanPersonaFolder } from '../lib/io/persona-store.mjs';
import { settingsUpdateUrl } from '../lib/dsh-api.mjs';

const SETTINGS_NS = 'im-qqbot-2';
const UPDATE_API = settingsUpdateUrl();
import { navButtons, handleNavClick } from '../lib/pure/card-nav.mjs';

/**
 * 人格按钮上限。
 *
 * ⚠️ 2026-11-09 发现并修的**存量 bug**：QQ 键盘在 `buttonsPerRow=1` 时最多只显示 5 个按钮
 *   （上游 `botplay.js: shown = buttons.slice(0, 5 * perRow)`），
 *   而原先这里是 8 张角色卡 + 1 个刷新 = 9 个 → **后 4 张卡从来没显示出来过**，
 *   主人以为"只有 5 个人格可选"。
 *   现在底部还要加 4 个功能按钮：8 + 1 + 4 = 13 个，
 *   事件配置的 `buttonsPerRow` 已同步改成 3（容量 5×3=15），13 个刚好放得下。
 */
const MAX_PERSONA_BUTTONS = 8;

async function loadRegistry() {
  try {
    const { importPluginModule } = await import('../lib/io/plugin-dist.mjs');
    return await importPluginModule('features/session-registry.js');
  } catch { return null; }
}

async function managerOf(ctx) {
  try {
    const direct = ctx?.kernel?.get?.('qqChannel');
    if (direct?.manager) return direct.manager;
  } catch { /* fallback */ }
  try {
    const reg = await loadRegistry();
    const scope = String(ctx?.event?.scope || '');
    const peerId = String(ctx?.event?.peerId || '');
    if (reg?.findManagerByPeer && scope && peerId) {
      const m = reg.findManagerByPeer(scope, peerId);
      if (m) return m;
    }
    if (reg?.managersOf) {
      const all = reg.managersOf();
      if (all.length === 1) return all[0];
    }
  } catch { /* ignore */ }
  return null;
}
export async function resetGroupSession(ctx) {
  const mgr = await managerOf(ctx);
  if (!mgr?.startNewSession) return { ok: false, error: '会话管理器不可用' };
  const scope = String(ctx?.event?.scope || '');
  const peerId = String(ctx?.event?.peerId || '');
  if (!scope || !peerId) return { ok: false, error: '会话目标为空' };
  const fallback = {
    replyTarget: { scope, targetId: peerId },
    senderId: String(ctx?.user?.openid || ''),
  };
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 8000); });
  let r;
  try {
    r = await Promise.race([mgr.startNewSession(scope, peerId, false, undefined, fallback), timeout]);
  } catch { r = 'error'; }
  finally { if (timer) clearTimeout(timer); }
  if (r === 'forked' || r === 'rotated') return { ok: true };
  if (r === 'timeout' || r === 'error') {
    try { await mgr.remove?.(scope, peerId); } catch { /* ignore */ }
    return { ok: true, rotated: true };
  }
  return { ok: false, error: '新会话创建失败' };
}

function gidOf(ctx) {
  return ctx?.event?.scope === 'group' ? String(ctx.event.peerId || '') : '';
}
function current(ctx) {
  const gid = gidOf(ctx);
  if (!gid) return null;
  const state = loadState();
  const gs = groupState(state, gid);
  const cfg = readConfig();
  gs.persona = normalizePersonaName(gs.persona, cfg);
  return { state, gid, gs, cfg };
}
function setCard(ctx, msg = '') {
  const c = ctx.card();
  const cur = current(ctx);
  if (!cur) {
    c.contentText = '## 🎭 人格切换\n\n这个功能只能在群里用。';
    c.buttons = [];
    return c;
  }
  const choices = listPersonaChoices(cur.cfg).slice(0, MAX_PERSONA_BUTTONS);
  c.contentText = [
    '## 🎭 本群人格',
    '',
    `当前：**${cur.gs.persona || '未配置'}**`,
    `可选：${choices.map((p) => p.name).join('、') || '无'}`,
    overlayReady() ? '切换组件：已就绪' : '切换组件：待重启 DSH',
    '本群群友均可切换；切换成功会开新会话。',
    msg ? `\n${msg}` : '',
  ].join('\n');
  c.buttons = [
    ...choices.map((p) => ({ id: `persona:${encodeURIComponent(p.name)}`, label: p.name, style: 1, botAction: { type: 'reply_text', text: '' } })),
    { id: 'refresh', label: '🔄 刷新当前人格', style: 1, botAction: { type: 'reply_text', text: '' } },
    // ★ 2026-11-09：底部追加功能按钮（4 项，**不含人格切换自己**——它不在功能列表里）
    ...navButtons('persona-switch'),
  ];
  return c;
}
function at(ctx) {
  const id = String(ctx?.user?.openid || '');
  return id ? ctx.at(id) + ' ' : '';
}
async function refreshActivePrompt() {
  try {
    const scan = scanPersonaFolder();
    if (!scan.defaultPersona) return { ok: false, error: '角色卡目录里没有可用人格' };
    const built = composePrompt(undefined, scan.config);
    if (!built.ok) return { ok: false, error: built.reason || '组合人格失败' };
    const res = await fetch(UPDATE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ns: SETTINGS_NS, patch: { groupPrompt: built.text } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: `设置接口 HTTP ${res.status}` };
    return { ok: true, len: built.text.length, persona: built.personaName, rules: scan.rules.files.length, validCards: scan.choices.length, invalidCards: scan.invalid.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
export default {
  name: '人格切换',
  onInit(ctx) { return setCard(ctx); },
  async onClick(ctx, info) {
    const id = String(info?.buttonId || '');
    // ★ 功能按钮（日历/骰子/抽签/来张图）：直接调用对应功能的现有实现，本卡不变形
    const nav = await handleNavClick(ctx, id);
    if (nav !== undefined) return nav;
    const cur = current(ctx);
    if (!cur) return '这个功能只能在群里用。';
    if (id === 'refresh') {
      const active = await refreshActivePrompt();
      if (active.ok) {
        const choices = listPersonaChoices(cur.cfg).map((p) => p.name);
        let selected = normalizePersonaName(cur.gs.persona, cur.cfg);
        if (!choices.includes(selected)) selected = active.persona;
        cur.gs.persona = selected;
        cur.gs.needsInjection = true;
        saveState(cur.state);
        setCard(ctx, `已重读人格文件夹：规则 ${active.rules} 个，可用角色卡 ${active.validCards} 张，未通过 ${active.invalidCards} 张；当前群 ${selected}；默认 ${active.persona}；${active.len} 字`);
        try { ctx.card().dirty = true; } catch { /* ignore */ }
        return `${at(ctx)}已重读人格文件夹：规则 ${active.rules} 个，可用角色卡 ${active.validCards} 张，当前群 ${selected}，默认 ${active.persona}。`;
      }
      return `${at(ctx)}刷新失败：${active.error}`;
    }
    if (!overlayReady()) return '人格切换组件还没加载，重启 DSH 后再试。';
    if (!id.startsWith('persona:')) return;
    const target = normalizePersonaName(decodeURIComponent(id.slice('persona:'.length)), cur.cfg);
    if (!target) return '这个群还没有可用人格卡。';
    if (cur.gs.persona === target) return `${at(ctx)}现在已经是 ${target} 了。`;
    const left = cooldownLeft(cur.gs);
    if (left > 0) return `${at(ctx)}切换冷却中，还剩 ${cooldownText(left)}。`;
    // 切换人格 = 换一个干净会话，避免旧人格上下文残留/OOC；刷新不重置。
    const reset = await resetGroupSession(ctx);
    if (!reset.ok) return `${at(ctx)}切换失败：${reset.error}；没有改动当前人格。`;
    cur.gs.persona = target;
    cur.gs.lastSwitchAt = Date.now();
    cur.gs.switchedBy = String(ctx.user?.openid || '');
    cur.gs.needsInjection = true;
    // ★ 2026-11-20 修 P0-3：saveState 现在返回 {ok}，失败必须告知用户。
    //   以前无返回值、也无重试 —— FUSE 瞬时 EPERM 会让「会话已换、人格没存」，
    //   下次进来回到旧人格且无任何自愈。
    const saved = saveState(cur.state);
    if (saved && saved.ok === false) {
      return `${at(ctx)}已切到「${target}」，但状态未能落盘（${saved.error || '写入失败'}）。` +
        '重启后可能回到原人格，请稍后重发一次 /人格 确认。';
    }
    // 切换后只回成功文本，不再刷新切换卡；否则卡片重发会盖掉成功提示。
    // 🔴 2026-11-07：补上组合后的实际字数（规则 + 人格卡合计），
    //   便于一眼确认「这次切到的是哪一版、有没有同步到位」。
    //   取不到字数时不影响切换成功（降级为不显示字数）。
    let lenInfo = '';
    try {
      const composed = composePrompt(target, cur.cfg);
      if (composed?.ok && composed.text) lenInfo = `，组合 ${composed.text.length} 字`;
      else if (composed?.reason) lenInfo = `，组合异常：${composed.reason}`;
    } catch { /* ignore */ }
    return `${at(ctx)}已切换到人格「${target}」并开启新会话${lenInfo}，本群 5 分钟内不能再切。`;
  },
};
