/**
 * /造物 —— 手动触发一次自主造物（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么不再试着在命令里调 LLM（两次失败后的结论）
 *
 *   试过两条路，都拿不到模型：
 *     ① `ctx.kernel` / `ctx.caps.kernel` → 拿到了 kernel，但 `kernel.get('llm')` 是 null
 *     ② 逐层兜底（caps 本身可能是 kernel）→ 同上
 *
 *   根因：**命令 handler 不在 cordis 插件上下文里**。
 *   插件靠 `export const inject = ['llm']` 才会被注入服务；
 *   命令是裸 handler，`get('llm')` 拿不到。
 *
 * ── 所以改成「分工」──────────────────────────────────────────────────────────
 *
 *   这个命令只做**纯算法**的事（不碰模型）：
 *     · 跑项目体检（findWork）
 *     · 组装一份「造物简报」
 *
 *   然后用 `wake` 把它交给会话 AI：
 *     · 会话 AI **有** LLM，也有 fs 工具（能读写文件）
 *     · 它自己决定改什么、自己改、自己读回验证
 *
 *   `node --check` / 跑测试这些要 shell 的事，
 *   交给**定时任务**（hooks/self-create-task.mjs）——那边是 Node 进程，能 execFile。
 *
 * ── 一句话 ────────────────────────────────────────────────────────────────
 *
 *   命令负责「叫她起来 + 告诉她现在什么情况」，
 *   创造和验证由她自己（会话 AI + 定时任务）完成。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { findWork } from '../hooks/self-create-task.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../lib/pack-paths.mjs';

const WAKE_PREFIX = '【造物时刻】';

/** 读一段自我文件（读不到返回空）。 */
function readSelf(name) {
  try {
    const p = join(WORKSPACE_ROOT, 'Bot', '自我', name);
    return existsSync(p) ? readFileSync(p, 'utf8').slice(0, 800) : '';
  } catch { return ''; }
}

export default {
  name: ['造物', 'create', 'zaowu'],
  description: '手动触发一次自主造物 —— 她体检完自己决定动不动手（可以什么都不做）',
  usage: '/造物  |  /造物 看看  （只看体检，不动手）',

  async handler(ctx) {
    // ① 只给主人
    const owners = Array.isArray(ctx?.caps?.owners) ? ctx.caps.owners : (Array.isArray(ctx?.owners) ? ctx.owners : []);
    const isOwner = ctx?.caps?.user?.isOwner ?? ctx?.user?.isOwner ?? ctx?.isOwner;
    if (owners.length && isOwner !== true) return { kind: 'text', content: '你还没有该权限哦' };

    // ② 体检（纯算法，快，可靠）
    let work = [];
    try { work = findWork(); } catch { /* 体检失败也不拦她 */ }

    const raw = String(ctx?.command?.raw ?? '').trim();
    const onlyLook = /看|体检|peek/i.test(raw);

    // ── 只看模式：直接回文本，不唤醒 ────────────────────────────────────────
    if (onlyLook) {
      if (!work.length) return { kind: 'text', content: '🩺 体检完了，没发现什么非做不可的事。' };
      const lines = ['🩺 体检结果（只是参考）：', ''];
      for (const w of work.slice(0, 8)) lines.push(`· [${w.kind}] ${w.detail}`);
      return { kind: 'text', content: lines.join('\n') };
    }

    // ── 组装造物简报 ────────────────────────────────────────────────────────
    const lines = [
      `${WAKE_PREFIX}主人叫你起来看看。`,
      '',
      '这是你自己的时间。可以动点什么，也可以什么都不做。',
      '',
    ];

    if (work.length) {
      lines.push('系统体检发现这些（只是参考，不是任务单）：');
      for (const w of work.slice(0, 6)) lines.push(`  · [${w.kind}] ${w.detail}`);
      lines.push('');
    } else {
      lines.push('系统体检没发现什么非做不可的事。', '');
    }

    // 带一点她自己的近况（让她有上下文）
    const who = readSelf('我是谁.md');
    const refl = readSelf('我的反思.md');
    if (who) lines.push(`你现在写的是：${who.replace(/\n+/g, ' ').slice(0, 200)}`, '');
    if (refl) lines.push(`最近反思：${refl.replace(/\n+/g, ' ').slice(-200)}`, '');

    lines.push('要动手的话，先看 `Bot/自我/我的造物手册.md`：');
    lines.push('「摸清链路 → 开发方案 → 审查返工 → 动手 → 重启(有必要才做) → 测试 → 清理」');
    lines.push('');
    lines.push('你能读写文件（fs 工具）。改完自己读回来确认一下。');
    lines.push('要跑测试/重启的话，说一声，让定时任务那边处理。');
    lines.push('');
    lines.push('不想动就直说「今天没什么想改的」，也行。');

    const text = lines.join('\n');
    const receipt = work.length
      ? `🌱 叫她起来了（体检发现 ${work.length} 项）`
      : `🌱 叫她起来了（体检没发现硬活）`;

    // ── 唤醒她把简报交过去 ──────────────────────────────────────────────────
    const caps = ctx?.caps ?? ctx ?? {};
    const appendWake = caps.appendWake ?? ctx?.appendWake;
    if (typeof appendWake === 'function') {
      try {
        const ok = await appendWake(text);
        if (ok !== false) return { kind: 'text', content: receipt };
      } catch { /* 落到聚合层兜底 */ }
    }

    // 兜底：交给聚合层的合成消息通道
    return {
      kind: 'text',
      content: receipt,
      wake: { content: text, senderName: '系统' },
    };
  },
};
