/**
 * /造物 —— 手动触发一次自主造物（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 关键设计：**在 handler 里直接跑完整造物流程，不靠会话 AI。**
 *
 * ── 为什么不返回 wake 交给会话 AI ─────────────────────────────────────────
 *
 *   QQ bot 用的是 `qqbot` preset，工具只有：
 *     persona / tool-fs / tool-fs-search / skill-filesystem / tool-skill / tool-todo
 *
 *   **没有 shell。** 而造物要做的事里有一半靠 shell：
 *     · node --check 验语法
 *     · 跑 mock 测试
 *     · 重启宿主
 *
 *   如果只返回 wake，她会「想改但没法验证」—— 等于让她闭着眼改代码。
 *
 * ── 所以走这里 ─────────────────────────────────────────────────────────────
 *
 *   命令 handler 本身是 Node 函数，能 require child_process。
 *   直接调 hooks/self-create-task.mjs 的 createOnce：
 *     · 找活（纯算法）
 *     · 让 LLM 出提案（从 ctx.kernel 拿 llm）
 *     · 应用 + 验证 + 回滚
 *     · 善后（跑测试/清垃圾/判断发版）
 *
 *   然后把结果告诉他，让他知道她干了什么。
 *
 * ── 拿不到 kernel 时 ───────────────────────────────────────────────────────
 *
 *   退化成「只做体检 + 告诉她该干什么」，不硬造。
 *   （失败关闭：没 LLM 就别瞎改）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createOnce, findWork } from '../hooks/self-create-task.mjs';

export default {
  name: ['造物', 'create', 'zaowu'],
  description: '手动触发一次自主造物 —— 她自己体检、自己决定改不改、改完自己验证（可以什么都不做）',
  usage: '/造物  |  /造物 看看  （只看体检，不动手）',

  async handler(ctx) {
    // ① 只给主人
    const owners = Array.isArray(ctx?.caps?.owners) ? ctx.caps.owners : (Array.isArray(ctx?.owners) ? ctx.owners : []);
    const isOwner = ctx?.caps?.user?.isOwner ?? ctx?.user?.isOwner ?? ctx?.isOwner;
    if (owners.length && isOwner !== true) return { kind: 'text', content: '你还没有该权限哦' };

    // ② 解析参数
    const raw = String(ctx?.command?.raw ?? '').trim();
    const onlyLook = /看|体检|peek/i.test(raw);

    // ③ 先体检（纯算法，快）
    let work = [];
    try { work = findWork(); } catch { /* ignore */ }

    // 只看模式
    if (onlyLook) {
      if (!work.length) return { kind: 'text', content: '🩺 体检完了，没发现什么非做不可的事。' };
      const lines = ['🩺 体检结果（只是参考）：', ''];
      for (const w of work.slice(0, 8)) lines.push(`· [${w.kind}] ${w.detail}`);
      return { kind: 'text', content: lines.join('\n') };
    }

    // ④ 拿 kernel（逐层兜底 —— 和 commands/子会话.mjs 的 svc() 同一套路）
    //    ⚠️ 关键：caps 本身可能就是 kernel（能力包平铺），所以 ?? ctx?.caps 这一层不能漏。
    const k = ctx?.caps?.kernel ?? ctx?.caps ?? ctx?.kernel ?? ctx?.ctx ?? ctx;
    const kernel = (k && typeof k.get === 'function') ? k : null;
    if (!kernel) {
      const tail = work.length
        ? `\n\n体检发现 ${work.length} 项：\n` + work.slice(0, 5).map((w) => `· [${w.kind}] ${w.detail}`).join('\n')
        : '';
      return {
        kind: 'text',
        content: `🌱 现在拿不到模型服务，做不了完整造物（只能体检）。${tail}\n\n等会儿再试，或者等每天自动那一次。`,
      };
    }

    // ⑤ 跑完整流程（会改文件、跑测试、可能重启）
    let result;
    try {
      result = await createOnce({ kernel }, { force: true });
    } catch (e) {
      return { kind: 'text', content: `造物出错了：${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}` };
    }

    // ⑥ 汇报
    if (result.skipped) {
      const why = result.skipped === 'no-llm' ? '拿不到模型' : result.skipped === 'already-today' ? '今天已经造过了' : result.skipped;
      return { kind: 'text', content: `🌱 今天先不动了（${why}）。` };
    }

    if (!result.changed) {
      const tail = work.length ? `\n\n体检有 ${work.length} 项，但这次没动。` : '';
      return { kind: 'text', content: `🌱 今天没什么想改的。${tail}` };
    }

    // 改了东西 → 详细汇报
    const lines = [`🌱 动了 ${result.changed} 处：`, ''];
    if (result.reason) lines.push(`起因：${result.reason}`, '');
    for (const a of result.applied) {
      lines.push(`· ${a.file}${a.why ? ` —— ${a.why}` : ''}`);
    }
    if (result.failed?.length) {
      lines.push('', `没成功 ${result.failed.length} 处：`);
      for (const f of result.failed) lines.push(`· ${f.file}（${f.error}）`);
    }
    if (result.aftercare?.notes?.length) {
      lines.push('', '善后：');
      for (const n of result.aftercare.notes) lines.push(`· ${n}`);
    }
    if (result.aftercare?.shouldRelease) {
      lines.push('', '⚠️ 改了仓库代码且测试过了，可以考虑发版。');
    }

    return { kind: 'text', content: lines.join('\n') };
  },
};
