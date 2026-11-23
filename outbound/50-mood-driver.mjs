/**
 * outbound/50-mood-driver — 用她的回复推进四维心理状态（2026-11-20 R5.4）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 历史遗留问题（2026-11-20 修复）：
 *
 *   旧代码读 `ctx.target.peerId` —— 这个字段**不存在**。
 *   真实结构是 `ctx.target.targetId`（见 qqbot dist/types.d.ts）。
 *   后果：`if (!gid) return next()` 每轮都从这里退出
 *        ⇒ advanceMood 从未被调用 ⇒ 情绪功能静默失效 726 次诊断全是 samples=0。
 *
 *   同类问题 10/20 号扩展早修过，50/55 漏了。现在修好，并加了 preflight 守护。
 *
 * ── 工作方式 ───────────────────────────────────────────────────────────────
 *   她回复 → onOutbound
 *     ├─ ① 推进四维（用她的回复文本抽信号）
 *     └─ ② 每 10 分钟应用一次生活基线（时段+心跳+素材，避免每轮读多个文件）
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────────────
 *   ① **只读不写正文**（rewrite 留给 55-sulk-prefix）
 *   ② **只处理最后一块**（避免同一轮算多次）
 *   ③ **失败关闭**（任何异常直接放行，绝不影响出站）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

export const name = 'mood-driver';

/** 桥的 Symbol key（与插件 src/index.ts 挂的保持一致） */
const BRIDGE_KEY = 'dsh.anti-ai-persona.mood.v1';

/** 生活基线应用间隔（毫秒）—— 10 分钟，避免每轮读多个文件 */
const LIFE_BASELINE_INTERVAL_MS = 10 * 60 * 1000;

/** 上次应用生活基线的时间（模块级，进程内）。 */
let lastLifeAppliedAt = 0;

/** 上次她回复的时间（用于算回复间隔）。 */
let lastReplyAt = 0;

/** 取桥（拿不到返回 null，调用方直接放行）。 */
function getBridge() {
  try {
    const k = Symbol.for(BRIDGE_KEY);
    return globalThis[k] || null;
  } catch {
    return null;
  }
}

/** 安全读 JSON。 */
function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 按小时算时段 id（与 mood-life 的 slotOfHour 一致）。 */
function slotOfHour(hour) {
  const h = ((Math.floor(Number(hour)) % 24) + 24) % 24;
  if (h >= 6 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'late_night';
}

/**
 * 收集生活层数据（读多个文件，有 IO 成本，所以不每轮做）。
 *
 * @returns {object|null} 失败返回 null
 */
function collectLifeData() {
  try {
    const PERSONA_ROOT = process.env.PERSONA_DATA_ROOT
      || `${process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home'}/.dsh/data/dsh-anti-ai-persona`;

    // ① 当前时段
    const now = new Date();
    const hour = now.getHours();
    const slotId = slotOfHour(hour);

    // ② 今日生活素材（daily-mood.json）
    let dayBaseline = {};
    let materialLayer = {};
    const daily = readJson(`${PERSONA_ROOT}/state/daily-mood.json`);
    if (daily?.slots) {
      dayBaseline = computeDayBaseline(daily.slots);
      const slotText = String(daily.slots[slotId] || '');
      if (slotText) {
        // 素材是今天抽的，按「距今小时数」衰减（用 generatedAt 推算）
        const genAt = Number(daily.generatedAt) || 0;
        const hoursAgo = genAt > 0 ? (Date.now() - genAt) / 3600000 : 0;
        materialLayer = computeMaterialLayer(slotText, hoursAgo);
      }
    }

    // ③ 外部状态：心跳 cold + 独处时长 + 今日生活流
    let heartbeatCold = false;
    let idleHours = 0;
    const hbDir = `${PERSONA_ROOT}/state/heartbeat`;
    // 遍历心跳目录，任一 cold 即算 cold（保守）
    try {
      for (const f of readdirSync(hbDir)) {
        if (!f.endsWith('.json')) continue;
        const hb = readJson(`${hbDir}/${f}`);
        if (hb?.cold === true) { heartbeatCold = true; break; }
        const lastBot = Number(hb?.lastBotMessageAt) || 0;
        if (lastBot > 0) {
          const h = (Date.now() - lastBot) / 3600000;
          if (h > idleHours) idleHours = h;
        }
      }
    } catch { /* 心跳目录读不到 → 跳过 */ }

    // ④ 今日生活流条数
    let todayLifeCount = 0;
    const life = readJson(`${PERSONA_ROOT}/state/life-stream.json`);
    if (life) {
      const today = now.toISOString().slice(0, 10);
      if (String(life.date || '') === today) todayLifeCount = Number(life.todayCount) || 0;
    }

    return {
      slotId,
      dayBaseline,
      materialLayer,
      externalLayer: computeExternalLayer({ heartbeatCold, idleHours, todayLifeCount }),
    };
  } catch {
    return null;
  }
}

/** 本地实现三层计算（避免从插件 dist 里 import，扩展侧拿不到）。 */
function computeDayBaseline(slots) {
  const o = slots && typeof slots === 'object' ? slots : {};
  const sums = {};
  let n = 0;
  for (const sid of ['morning', 'afternoon', 'evening', 'late_night']) {
    const text = String(o[sid] ?? '').trim();
    if (!text) continue;
    const sig = extractMaterialSignals(text);
    for (const [k, v] of Object.entries(sig)) {
      if (!Number.isFinite(v)) continue;
      sums[k] = (sums[k] || 0) + v;
    }
    n += 1;
  }
  if (!n) return {};
  const out = {};
  for (const [k, v] of Object.entries(sums)) out[k] = v / n;
  return out;
}

function decayOf(hoursAgo) {
  const h = Number(hoursAgo);
  if (!Number.isFinite(h) || h <= 0) return 1;
  return Math.pow(0.5, h / 6);
}

function computeMaterialLayer(text, hoursAgo) {
  const sig = extractMaterialSignals(text);
  const d = decayOf(hoursAgo);
  const out = {};
  for (const [k, v] of Object.entries(sig)) {
    if (!Number.isFinite(v)) continue;
    out[k] = v * d * 0.2;
  }
  return out;
}

function computeExternalLayer(ext) {
  const o = ext && typeof ext === 'object' ? ext : {};
  const out = {};
  if (o.heartbeatCold === true) out.connection = (out.connection || 0) - 0.30;
  const idle = Number(o.idleHours);
  if (Number.isFinite(idle) && idle > 2) {
    out.connection = (out.connection || 0) + Math.min(0.15, (idle - 2) * 0.03);
  }
  const cnt = Number(o.todayLifeCount);
  if (Number.isFinite(cnt) && cnt > 3) {
    out.energy = (out.energy || 0) - 0.05 * Math.min(3, cnt - 3);
  }
  return out;
}

/** 从生活素材抽信号（与 mood-life.extractMaterialSignals 同规则）。 */
function extractMaterialSignals(text) {
  const t = String(text ?? '');
  if (!t) return {};
  const s = {};
  if (/心情很好|心情好|开心|高兴|愉快|满足|舒服|笑|好运|好日子|不错|挺好|真好|亮|暖|有趣|顺利|运气|好听的|好吃|甜/u.test(t)) {
    s.mood = 0.3;
  } else if (/难过|失落|闷|烦|空落|孤单|伤心|提不起|沉|灰蒙蒙|懒|无聊|没胃口/u.test(t)) {
    s.mood = -0.3;
  }
  if (/精神|元气|有劲|力气|清醒|神清气爽|效率|状态好|起得早|浑身/u.test(t)) {
    s.energy = 0.3;
  } else if (/困|累|没睡|疲|软绵绵|睁不开|哈欠|晕|缓一缓|懒|跑了一天|不想动/u.test(t)) {
    s.energy = -0.3;
  }
  if (/想说话|陪我|聊聊|说说|谁陪|想跟|说说话|有人在吗|想聊|讲给|聊天|说话|你们|大家/u.test(t)) {
    s.connection = 0.3;
  } else if (/不想说|安静|一个人|独自|谁也不理|不聊|小世界|缩回|发呆|不想被/u.test(t)) {
    s.connection = -0.3;
  }
  if (/从容|放松|平静|不着急|不紧不慢|挺静|安心|挺好|慢慢|不用赶|不觉得亏|也挺好/u.test(t)) {
    s.composure = 0.3;
  } else if (/紧张|不安|慌|担心|悬着|七上八下|胡思乱想|不踏实|一定|必须|该办好|没做好|想些没用/u.test(t)) {
    s.composure = -0.3;
  }
  return s;
}

export default async function onOutbound(ctx, next) {
  try {
    // ★ 只处理本回合最后一个正文块（避免同一轮多次推进）
    if (ctx?.isLastChunk === false) return next();

    // ★ 只对文字回复生效（卡片/媒体/转发没有"语气"可言）
    const kind = String(ctx?.kind || '');
    if (kind && kind !== 'text') return next();

    const text = String(ctx?.text || '').trim();
    if (text.length < 2) return next();          // 太短判不出情绪

    // ★ 2026-11-20 R5.4 修：真实字段是 target.targetId，不是 peerId！
    //   查 qqbot dist/types.d.ts：ReplyTarget = { scope, targetId, msgId? }
    //   旧代码读 peerId 恒为 undefined ⇒ 整个扩展每轮都从这里退出 ⇒ 功能等于不存在。
    //   （10/20 号扩展早已修过，50/55 漏了 —— 这就是情绪和小脾气从未生效的真根因。）
    const gid = String(ctx?.target?.targetId ?? ctx?.target?.peerId ?? '');
    if (!gid) return next();

    const bridge = getBridge();
    if (!bridge || typeof bridge.advance !== 'function') return next();

    // ① 推进四维（每轮）
    const nowMs = Date.now();
    const latencyMs = lastReplyAt > 0 ? nowMs - lastReplyAt : 0;
    lastReplyAt = nowMs;
    const _re = bridge.advance(text, { latencyMs });

    // ② 应用生活基线（每 10 分钟一次，避免每轮读多个文件）
    const now = Date.now();
    if (now - lastLifeAppliedAt > LIFE_BASELINE_INTERVAL_MS) {
      lastLifeAppliedAt = now;
      try {
        const lifeData = collectLifeData();
        if (lifeData && typeof bridge.applyLifeBaseline === 'function') {
          bridge.applyLifeBaseline(lifeData);
        }
      } catch { /* 生活层失败不影响主流程 */ }
    }
  } catch {
    // 绝不影响出站
  }
  return next();
}
