/**
 * persona-group-overlay — 按群注入非默认人格；默认人格已包含在全局 groupPrompt。
 * 人格 ID = 角色卡文件名去掉 .md。
 */
import { randomUUID } from 'node:crypto';
import { loadState, saveState, groupState, markOverlayReady } from '../lib/io/persona-switch.mjs';
import { readConfig, defaultPersona, normalizePersonaName, resolvePersona } from '../lib/io/persona-store.mjs';
// ★ 2026-11-17 overlay 优化：不再"每轮注 14KB"，改为"overlay 丢了才补"
//   根因：非默认人格原先每轮注入完整卡（实测 14 步注 14 次，平均 6.8s vs 默认人格 3.1s）
//   依据：dsh-compaction-basic 压缩只保留 node0 的 system/message + 尾部 16% 原文，
//        我们的 overlay 是 role:'user' ⇒ 被卷进折叠就消失 ⇒ 必须靠 surface 检测补位。
import { overlayAlive, countOverlays } from '../lib/overlay/detect.mjs';
import { buildCompactOverlay, buildFullOverlay, COMPACT_MAX_CHARS } from '../lib/overlay/compact.mjs';

export const name = 'persona-group-overlay';

// 进程重启后，即使 sessionId 没变，也要把本群人格重新注入一次。
const bootInjected = new Set();

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function sanitizeLoneSurrogates(text) {
  return String(text ?? '').replace(LONE_SURROGATE, '\uFFFD');
}
function sanitizeDecision(decision) {
  try {
    for (const msg of (decision?.messages || [])) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && typeof block === 'object' && typeof block.text === 'string') {
          block.text = sanitizeLoneSurrogates(block.text);
        }
      }
    }
  } catch { /* ignore */ }
}
function groupOfAgent(agent) {
  try {
    const ch = agent?.ctx?.get?.('qqChannel');
    const mgr = ch?.manager;
    const rec = mgr?.findByAgent?.(agent) || (agent?.session?.id ? mgr?.findBySessionId?.(agent.session.id) : undefined);
    return rec?.scope === 'group' ? String(rec.peerId || '') : '';
  } catch { return ''; }
}
function overlayMessage(text, persona) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }],
    source: { kind: 'qqbot:persona-overlay', persona: String(persona) },
  };
}
const RESTORE_TEXT = '【本群人格恢复】\n本群已切回默认人格。此前若注入过本群人格覆盖，现在以全局角色卡的人格层为准；安全规则、权限、18+ 边界不变。';

export async function run(env) {
  const ctx = env?.ctx;
  if (!ctx?.on) return 'no-ctx';
  const handler = async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
      sanitizeDecision(decision);
      const agent = payload?.agent;
      const gid = groupOfAgent(agent);
      if (!gid) return decision;
      const sid = String(agent?.session?.id || '');
      const cfg = readConfig();
      const def = defaultPersona(cfg);
      if (!def) return decision;
      const state = loadState();
      const gs = groupState(state, gid);
      const selected = normalizePersonaName(gs.persona, cfg);
      const previous = normalizePersonaName(gs.injectedPersona, cfg);
      const sessionChanged = !!(gs.injectedSessionId && sid && gs.injectedSessionId !== sid);
      const firstBootTurn = !bootInjected.has(gid);

      // ★ 2026-11-17 overlay 优化（核心改动）
      //
      // 旧行为：非默认人格**每轮都注入完整卡 14KB**（防上下文折叠后 overlay 消失）。
      //         实测：14 步注 14 次，平均 6.8s；默认人格 162 步注 1 次，平均 3.1s。
      //
      // 新行为：**查会话 surface，overlay 还在就不注入**；
      //         overlay 被压缩折叠掉了才注入（首次完整卡，之后摘要）。
      //
      // 安全性：
      //   · surface 查不到（宿主机版本变化等）→ overlayAlive 返回 false → 退回旧行为（每轮注入）
      //   · 摘要提取失败 → 回退注入完整卡
      //   · 配置 overlayCompact:false → 完全退回旧行为
      //
      // ⚡ 性能优化（2026-11-17 审查补充）：
      //   · 默认人格不扫 surface（它本来就没有 overlay，扫了纯浪费 O(n)）
      //   · 已确认要注入的情况不再扫（省一次遍历）
      const compactMode = cfg?.overlayCompact !== false;
      const isDefaultPersona = !selected || selected === def.name;
      const knownNeedInject = !!(gs.needsInjection || sessionChanged || firstBootTurn);

      // 已确定要注入 → 不用扫；默认人格 → 不扫（它不需要 overlay 存活检测）
      const alive = (!knownNeedInject && compactMode && !isDefaultPersona)
        ? overlayAlive(agent, selected)
        : false;

      // 需要注入的两种情况：
      //   ① 状态要求注入（切换人格 / 新会话 / 进程重启首次）
      //   ② overlay 已不在上下文里（被压缩折叠掉了）
      if (!knownNeedInject && alive) return decision;

      // ⚡ 早退出（2026-11-17 审查补充）：默认人格 + 无需注入 + 之前也不是非默认人格
      //   → 什么都不用做。若不早退，默认人格群每轮都会白跑完下面一整套判断。
      //   注意：previous !== def.name 时不能早退 —— 那是「从非默认切回默认」，要注入 RESTORE_TEXT。
      const needRestore = !!(previous && previous !== def.name);
      if (!knownNeedInject && isDefaultPersona && !needRestore) return decision;

      // 首次（切换/新会话/重启）→ 完整卡；折叠后补位 → 摘要
      const isFirstTime = knownNeedInject;

      let text = '';
      if (selected && selected !== def.name) {
        const p = resolvePersona(selected, cfg);
        if (p?.valid) {
          if (isFirstTime) {
            text = buildFullOverlay(p.text, selected);
          } else {
            // 折叠后补位：优先摘要；摘要提不出来（卡格式异常）就退回完整卡
            const compact = buildCompactOverlay(p.text, selected);
            text = compact
              ? `【本群人格提醒】\n本群人格仍是「${selected}」（不是默认人格）。\n\n${compact}`
              : buildFullOverlay(p.text, selected);
          }
        }
      } else if (previous && previous !== def.name) {
        text = RESTORE_TEXT;
      }
      if (text) decision.messages.push(overlayMessage(text, selected || def.name));
      /**
       * ★★ 2026-11-24 架构调整（P2）：**不再把解析后的名字写回 gs.persona**。
       *
       * 原实现无条件 `gs.persona = selected || def.name`，后果：
       *   · persona-path.mjs 声明「persona: '' 是未显式设置，要回落默认」，
       *     但第一回合就被写死成当时的具体名字 ⇒ 该语义失效；
       *   · 之后改 persona-config.json 的 defaultPersona，这些群**不会跟随**。
       *   · 实测（2026-11-24）：生产 8 个群全是 '爱莉希雅'，其中 2 个群
       *     lastSwitchAt 为 '-'（从没被切换过）——都是被这里自动钉上的。
       *   · 别名/卡被删时同样会被这里覆盖。
       *
       * 现在：gs.persona 只由**用户显式切换**写入（botplay/persona-switch.mjs），
       * 本 hook 只记录注入事实（injectedPersona / injectedSessionId），
       * 空串语义得以保留 ⇒ 改默认人格时未显式切换的群会自动跟随。
       */
      gs.needsInjection = false;
      gs.injectedPersona = selected || def.name;
      gs.injectedSessionId = sid;
      bootInjected.add(gid);
      saveState(state);
    } catch { /* ignore */ }
    return decision;
  };
  const off = ctx.on('agent/pre-step', handler, { prepend: true });
  markOverlayReady();
  try {
    env?.registerDispose?.(() => { try { if (typeof off === 'function') off(); } catch { /* ignore */ } });
  } catch { /* ignore */ }
  return 'ok';
}
export function dispose() { /* registered via ctx */ }
export default { name: 'persona-group-overlay', run, dispose };
