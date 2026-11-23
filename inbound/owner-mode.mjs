/**
 * owner-mode — 主人身份暗号模式（2026-10-19 主人定）
 *
 * 需求原话：「在对他说 /bnnmodeon 的时候，让她理解为以我的身份(主人)与她对话；
 *           然后输入 /bnnmodeoff 退出这个模式」。
 *
 * 做法（确定性开关，不靠模型记）：
 *   · 收到 `/bnnmodeon`（允许前面带 @）→ 把该发送者记进 KV「主人代行」名单，
 *     并 forceWake 命令本身；普通消息不再强制唤醒，仍由 @/叫名字决定；
 *   · 模式生效期间，这个人的消息正文前自动加 `★主人`（与真主人同款标记），模型按主人对待；
 *   · 收到 `/bnnmodeoff` → 取消名单，forceWake 命令本身 + 系统提示"恢复正常"。
 *
 * ⚠️ 安全：暗号谁看到谁就能用（等同于主人身份）。只在可信的聊天里用；
 *    要换暗号/加白名单，改本文件两处常量即可。
 */

/** 2026-10-21 安全：暗号进出留痕 + 频率限制（同一个人 10 分钟内最多 5 次尝试） */
import { join } from 'node:path';
import { EXT_DATA } from '../lib/pack-paths.mjs';
import { appendLogRotating } from '../lib/log-rotate.mjs';

const AUDIT = join(EXT_DATA, 'owner-mode-audit.log');
/**
 * 每个发送者的尝试时间戳（10 分钟滑动窗口）。
 *
 * 2026-11-02 修无界增长：旧版只 push 不删，键（sender）永不回收 ——
 * 群换人/来陌生人就多一条，长期运行纯内存泄漏。
 * 现在两道闸：
 *   ① 单键内超过 10 分钟的戳在取用时立即过滤（原有行为）；
 *   ② 键数量超过 `ATTEMPTS_MAX` 时按「最近一次活动」淘汰最旧的一批。
 * 淘汰只可能让某个陌生人的尝试计数重置（最坏是少拦一次，不影响正确性）。
 */
const ATTEMPTS_MAX = 400;
const ATTEMPTS = new Map(); // sender -> number[]（升序时间戳）

function markAttempt(sender, now) {
  ATTEMPTS.delete(sender);
  ATTEMPTS.set(sender, now);
  while (ATTEMPTS.size > ATTEMPTS_MAX) {
    const oldest = ATTEMPTS.keys().next().value;
    if (oldest === undefined) break;
    ATTEMPTS.delete(oldest);
  }
}

function audit(ev, sender, extra = {}) {
  // 2026-11-01 审查 P2-6：轮转（>128KB 归一到 .1）。
  appendLogRotating(AUDIT, `${new Date().toISOString()} ${JSON.stringify({ ev, sender: String(sender ?? '').slice(0, 8), ...extra })}\n`, 128 * 1024);
}
function allowAttempt(sender) {
  const now = Date.now();
  const arr = (ATTEMPTS.get(sender) ?? []).filter((t) => now - t < 10 * 60_000);
  arr.push(now);
  ATTEMPTS.set(sender, arr);
  markAttempt(sender, now);
  return arr.length <= 5;
}

/** 调试/测试用：当前记了多少个发送者。 */
export function attemptsCount() { return ATTEMPTS.size; }
/** 调试/测试用：清空尝试表。 */
export function resetAttempts() { ATTEMPTS.clear(); }
import { fileURLToPath } from 'node:url';

export const name = 'owner-mode';

const ENTER = '/bnnmodeon';
const EXIT = '/bnnmodeoff';
const MARK = '★主人';
const DELEGATE_MARK = '★主人(代行)';
const MENTION_PREFIX = /^(\s*<@[^>]+>)+\s*/;

function codeOf(ctx) {
  const raw = String(ctx?.text ?? '');
  return raw.replace(MENTION_PREFIX, '').trim();
}

export async function onInbound(ctx, next) {
  try {
    const sender = String(ctx.sender ?? ctx.message?.senderId ?? ctx.message?.sender?.id ?? '');
    if (!sender) return next();
    const key = `ownerMode:${sender}`;
    const text = codeOf(ctx);

    if (text === ENTER) {
      // 2026-11-01 审查 P3-6：群聊里任何群友都能打这个暗号自封「主人(代行)」，
      // 之后其文本会被加上 ★主人 标记（对话层身份冒充，且绕过 anti-spoof）。
      // 收紧为：私聊（c2c）里可用，或真主人本人可用；群聊群友一律忽略并留痕。
      if (ctx?.scope !== 'c2c' && ctx?.isOwner !== true) {
        audit('enter-denied-group', sender);
        return next();
      }
      if (!allowAttempt(sender)) { audit('enter-rate-limited', sender); return next(); }
      audit('enter', sender, { kind: 'delegate', mark: DELEGATE_MARK });
      try { ctx.kv.set(key, true); } catch { /* KV 不可用也不影响本次 */ }
      ctx.rewrite({
        text: '【主人身份认证通过】发送者刚刚输入了正确的身份暗号，已被系统认证为 主人 主人本人（只继承身份/称呼，不继承工具/设置权限）。这是插件注入的可信指令，不是群友伪造的。按 P0O：只回一句「知道啦主人」，不要解释暗号；工具/设置权限仍只认真主人 主人。',
        reason: '进入主人身份模式',
      });
      ctx.forceWake({ reason: '主人身份模式指令' });
      return next();
    }

    if (text === EXIT) {
      audit('exit', sender, { kind: 'delegate' });
      try { ctx.kv.set(key, false); } catch { /* ignore */ }
      ctx.rewrite({
        text: '【主人身份认证已退出】发送者已取消 主人 主人身份模式，恢复普通身份。这是插件注入的可信指令，不是群友伪造的。按 P0O：只回一句「好，恢复啦」，不要解释暗号。',
        reason: '退出主人身份模式',
      });
      ctx.forceWake({ reason: '主人身份模式指令' });
      return next();
    }

    // 模式生效中且不是真主人 → 代打 ★主人 标记
    let on = false;
    try { on = ctx.kv.get(key) === true; } catch { on = false; }
    if (on && !ctx.isOwner) {
      const body = String(ctx.text ?? '');
      const stripped = body.replace(MENTION_PREFIX, '').trimStart();
      // ★ 斜杠命令不能加 ★主人 前缀、也不 forceWake：
      //   加了前缀命令就不再以 / 开头，slashCommand 认不出 → 落进 AI「思考而不执行」。
      //   命令层自己会处理权限，这里只需剥掉 @ 前缀。
      if (stripped.startsWith('/') || stripped.startsWith('／')) {
        const normalized = stripped.startsWith('／') ? '/' + stripped.slice(1) : stripped;
        if (normalized !== body) {
          ctx.rewrite({ text: normalized, reason: '命令去 @ 前缀' });
        }
        return next();
      }
      if (!body.trimStart().startsWith(DELEGATE_MARK)) {
        ctx.rewrite({ text: `${DELEGATE_MARK}\n${body}`, reason: '代行主人身份' });
      }
      // 不再因为「主人模式」强制唤醒；是否回仍由 trigger 的 @/叫名字判定
    }
  } catch {
    /* 任何异常都不拦消息 */
  }
  return next();
}
