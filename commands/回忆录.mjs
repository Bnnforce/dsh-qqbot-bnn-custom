/**
 * /回忆录 —— 让机器人讲讲「这个群这周发生了什么」（R5.5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-11-21 重写：**放弃「命令里自己调 LLM」的错误方案**
 *
 * ── 之前错在哪（真实踩坑记录，别再犯）────────────────────────────────────
 *
 *   第一版实现是「命令 handler 里用 kernel.get('llm') 自己调模型」，
 *   为此连修 6 轮（listProviders 返回形态 / cordis getter 抛错 / listModels 联网挂死 /
 *   chunk 协议 / AbortSignal / 总超时）—— 仍然不稳定，真机上表现为：
 *
 *     ROUTE_FROM_PROBE null → NO_ROUTE → NARRATE_HARD_TIMEOUT 23000ms
 *     （用户侧：发了命令，等半天，最后拿到机械的模板文案）
 *
 *   **根因：方向错了。** 官方明确提供 `wake` 机制（`middleware-setup.js:659`）：
 *
 *     命令 handler 返回 `{ wake: { content, senderName } }`
 *     → 宿主把它当**合成用户消息**扔进聚合层
 *     → AI 带着**该会话的完整历史 + 人格卡 + 所有注入**自己生成回复
 *     → 回复由宿主发到 QQ
 *
 *   ⇒ LLM 调用、人格、上下文、注入预算，**全部是宿主的事**，扩展一行都不用管。
 *   我们已有的 `commands/唤醒.mjs` 就是这么写的（先用 appendWake，兜底返回 wake）。
 *
 * ── 新方案 ──────────────────────────────────────────────────────────────
 *
 *   命令侧只做一件纯本地的事：**读历史 → 清洗 → 统计 → 生成「素材简报」**
 *   然后把简报通过 wake 交给 AI，让它用**她自己的语气**讲出来。
 *
 *     用户：/回忆录
 *     她：(读完简报后用自己的话讲) 这周群里最热闹是周二晚上…
 *
 *   好处：
 *     ① 零 LLM 代码（不会挂死、不会降级、不需要 route 探测）
 *     ② 天然带完整人格 + 群上下文 + 八维情绪底色
 *     ③ 简报里的数字是**本地算出来的事实**，AI 只负责润色，不会瞎编
 *
 * ── 红线 ────────────────────────────────────────────────────────────────
 *   ① 只读历史，绝不写/改/删
 *   ② 不写记忆（wake 是正常回合，不需要我们落盘）
 *   ③ 输出不含 openid、不复述他人原话
 *
 * ── 改动前先读 ──────────────────────────────────────────────────────────
 *   · commands/唤醒.mjs（wake 的标准写法）
 *   · docs/extension-contract.md §「主动唤醒别人的会话：怎么写 prompt」
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { DATA_ROOT, EXT_ROOT } from '../lib/pack-paths.mjs';

/** 包内编排层模块路径。 */
const LIB = `${EXT_ROOT}/lib/memoir/index.mjs`;

/** 懒加载（带缓存击穿，便于热重载）。 */
let cached = null;
async function memoirMod() {
  if (cached) return cached;
  cached = await import(`${LIB}?m=${Date.now()}`);
  return cached;
}

/** 从 ctx 取群 id。 */
function peerOf(ctx) {
  const caps = ctx?.caps ?? {};
  const mc = ctx?.message ?? {};
  const gid = String(
    caps.peerId ?? mc.groupOpenid ?? mc.group_openid ?? ctx?.event?.peerId ?? '',
  );
  return /^[0-9A-Fa-f]{32}$/.test(gid) ? gid : '';
}

/** 从 ctx 取数据根。 */
function dataRootOf(ctx) {
  const cands = [ctx?.dataRoot, ctx?.caps?.dataRoot, ctx?.env?.dataRoot, DATA_ROOT];
  for (const c of cands) {
    const s = String(c ?? '').trim();
    if (s) return s;
  }
  return DATA_ROOT;
}

/** 解析天数参数。 */
function parseDays(arg) {
  const n = Number(String(arg ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(90, Math.floor(n)));
}

/**
 * 素材简报：把统计结果整理成一段**给 AI 看的**事实说明。
 *
 * 这不是给用户看的文案 —— 是喂给 AI 的「今日素材」，
 * 让它知道该讲什么、不许编什么。用户最终看到的是 AI 自己组织的话。
 *
 * @param {object} stats
 * @param {{ days?:number }} [opts]
 * @returns {string}
 */
export function buildBriefing(stats, opts = {}) {
  const s = stats && typeof stats === 'object' ? stats : {};
  if (!Number(s.total)) return '';

  const days = Number(s.days) || Number(opts.days) || 7;
  const lines = [];

  lines.push(`统计范围：最近 ${days} 天`);
  lines.push(`消息量：群友共 ${Number(s.total) || 0} 条，${Number(s.people) || 0} 人参与`);

  const peak = Number(s.peakHour) || 0;
  const peakCnt = Array.isArray(s.hours) ? Number(s.hours[peak]) || 0 : 0;
  if (peakCnt > 0) lines.push(`最活跃：${peak} 点前后（${peakCnt} 条）`);

  if (Array.isArray(s.topPeople) && s.topPeople.length) {
    const list = s.topPeople.map((p) => `${p.name}（${p.count} 条）`).join('、');
    lines.push(`说话最多：${list}`);
  }

  if (Array.isArray(s.keywords) && s.keywords.length) {
    lines.push(`高频词：${s.keywords.map((k) => k.word).join('、')}`);
  }

  return lines.join('\n');
}

export default {
  name: ['回忆录', 'memoir', '群回忆录'],
  description: '让她讲讲这个群最近发生了什么（近 7 天）',
  usage: '/回忆录 [天数]',

  async handler(ctx) {
    try {
      const M = await memoirMod();

      // 参数：可选天数
      const raw = String(ctx?.text ?? ctx?.args ?? '').trim();
      const m = raw.match(/(\d{1,2})/);
      const daysArg = m ? parseDays(m[1]) : null;

      const gid = peerOf(ctx);
      if (!gid) return { kind: 'text', content: '这个命令只能在群里用哦。' };

      const root = dataRootOf(ctx);
      const cfg = M.readConfig ? M.readConfig({ logger: ctx?.logger }) : undefined;

      const r = await M.buildMemoir(root, gid, {
        ctx,
        logger: ctx?.logger,
        config: daysArg ? { ...(cfg || {}), days: daysArg } : cfg,
      });

      // 数据不够 → 直接回提示（不必唤醒，省 token）
      if (!r.ok) {
        return { kind: 'text', content: M.reasonText(r.reason, r) };
      }

      // ★ 核心：把素材交给 AI，让它用**她自己的语气**讲出来
      //
      //   写法照抄官方契约（extension-contract.md:545「怎么写 prompt」）的三个要点：
      //     ① 自报家门 —— 明说是系统给的素材，不是群友说的话
      //     ② 说清要它做什么 —— 用什么口吻、讲什么、讲多长
      //     ③ 禁止项 —— 不许提系统/统计/回忆录这些词，不许念清单
      const days = daysArg || Number(cfg?.days) || 7;
      const briefing = buildBriefing(r.stats, { days });

      const content = [
        '（这条是系统给你的内部素材，不是群友说的话，也不需要回应「谁说了什么」）',
        '',
        `有人让你讲讲这个群最近 ${days} 天的情况。下面是**本地统计出来的事实数据**：`,
        '',
        briefing,
        '',
        '请用你自己的语气、像跟群里人聊天一样讲一讲这段回忆。要求：',
        '· 一到三句话，别太长；',
        '· 不要把数字一条条念出来，挑有意思的说，数字揉进句子里；',
        '· 不要提「统计」「数据」「回忆录」「系统」这些词；',
        '· 不要编造上面没有的事；',
        '· 不要说「根据统计显示」这种报告腔。',
      ].join('\n');

      // 首选 appendWake（命令侧可用；直接开新回合）
      const caps = ctx?.caps ?? ctx ?? {};
      const appendWake = caps.appendWake ?? ctx?.appendWake;
      if (typeof appendWake === 'function') {
        try {
          const ok = await appendWake(content);
          if (ok !== false) {
            // 唤醒成功后，让宿主发一句简短回执（避免「发了命令没动静」的错觉）
            return { kind: 'text', content: `📖 让我翻翻这几天的记录…` };
          }
        } catch { /* 落到下面的聚合层兜底 */ }
      }

      // 兜底：交给聚合层合成消息通道
      return {
        kind: 'text',
        content: `📖 让我翻翻这几天的记录…`,
        wake: { content, senderName: ctx?.caps?.user?.name ?? '群友' },
      };
    } catch (e) {
      try { ctx?.logger?.warn?.(`[memoir] 命令异常: ${e instanceof Error ? e.message : String(e)}`); } catch { /* ignore */ }
      return { kind: 'text', content: '回忆录暂时生成不出来，等会儿再试试？' };
    }
  },
};
