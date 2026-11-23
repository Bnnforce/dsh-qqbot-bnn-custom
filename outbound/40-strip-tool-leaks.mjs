/**
 * strip-tool-leaks — 把「使用 text_break / 使用 [rf:xxx]」这类**工具名残渣**从出站正文里清掉
 *
 * 背景（2026-10-18 主人截图/群聊实测）：kilo 等模型有时不调 `text_break` 工具，
 * 而是在正文里写「使用 text_break，下一句…」「使用 [rf:10183]，主人好呀…」——
 * 这些字被原样发到 QQ，主人看到「这上面怎么又来个 text break」。
 *
 * 做法：出站前正则清洗（只动正文，不碰真正的工具调用/媒体标记）：
 *   ① 删「使用 text_break」（含 text_break / text break 各种写法）及其后紧跟的标点；
 *   ② 删引用/媒体标记前的「使用」两个字（标记本身留给 rich-media 解析）；
 *   ③ 删孤立出现的 text_break 字样；
 *   ④ 清理正文首尾多余标点/空格；若整条只剩残渣 → 这条不发（annihilate）。
 *
 * 注意：这是**兜底**，不是鼓励模型写它；规则里也明确要求"别把工具名当正文念"。
 */
export const name = 'strip-tool-leaks';

// ★ 2026-11-20 适配 qqbot 1.13.18+：表情安全层（见 lib/pure/face-safe.mjs 头注释）。
import { maskFaces } from '../lib/pure/face-safe.mjs';

export default async function onOutbound(ctx, next) {
  try {
    const rawIn = String(ctx?.text ?? '');
    if (!rawIn) return next();

    // ★ 2026-11-20 适配 qqbot 1.13.18+：先掩码 QQ face 控制字符再做清洗。
    //   上游顺序是「先把【表情:XX】换成真 face → 再跑出站扩展」⇒ 我们拿到的是含
    //   `U+0014` + id 的正文。本模块有一堆正则（含去掉首尾标点/空白），
    //   可能把 face 与它的 id 拆开或吞掉 ⇒ 群里显示空白，且日志无痕。
    //   掩码后正则只见普通字符，回写时再按顺序还原。
    const { text: raw, restore } = maskFaces(rawIn);
    /** 回写（先还原表情）。所有 rewrite 都必须走它，避免漏还原。 */
    const emit = (s) => { try { ctx.rewrite?.(restore(s)); } catch { /* ignore */ } };

    let t = raw;

    // 0) ★ 思考块（模型偶发把思维链包在标签里）先整块删掉
    t = t.replace(/<thought>[\s\S]*?<\/thought>/gi, '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
    if (!t) {
      try { ctx.annihilate?.('只有思考块，已拦截'); } catch { /* ignore */ }
      return;
    }

    // 0) ★ 2026-10-20：工具不存在（UNKNOWN_TOOL）的报错属于内部噪音，绝不能发到群里。
    //    典型文本：`❌ 工具 analyze_image 执行失败\nToolNotFoundError: UNKNOWN_TOOL`
    const before = t;
    t = t
      // 工具执行失败的第一行（任意工具；QQ 插件会把工具名/错误码套反引号）＋错误类型行
      .replace(/^\s*(?:<@!?[^>]+>\s*)*(?:❌\s*)?工具\s*`?[^\s`]+`?\s*执行失败.*$/gim, '')
      .replace(/^\s*`?(?:ToolNotFoundError|ToolError|UnknownError|TypeError|ReferenceError|SyntaxError|RangeError|Error|WebError)[:：].*$/gim, '')
      .replace(/^.*UNKNOWN_TOOL.*$/gim, '')
      .replace(/^.*ToolNotFoundError.*$/gim, '')
      // 模型/流式内部异常（2026-10-22 群聊实测：⚠️ 本轮异常结束 + STREAM_CUT）
      .replace(/^\s*⚠️?\s*本轮异常结束.*$/gim, '')
      .replace(/^.*STREAM[_-]?CUT.*$/gim, '')
      .replace(/^.*continuation ended without a complete ans.*$/gim, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (before !== t) {
      try { ctx.logger?.debug?.('[strip-tool-leaks] 已吞掉工具不存在报错'); } catch { /* ignore */ }
      if (!t) {
        try { ctx.annihilate?.('工具执行报错属于内部信息，已拦截'); } catch { /* ignore */ }
        return; // 整条都是内部报错 → 不发
      }
      emit(t);
    }

    // ── 0.5) 思考/规则/人设泄漏（2026-10-21 主人报：bot 把「根据 P0G 规则…无需回复」发到群里）──
    //  A. 整段人设/守则指纹：命中多处 → 整条不发
    const FINGERPRINTS = [
      '爱莉希雅 角色卡', '比安安 角色卡', 'Bnnbot 角色卡', '【最高优先·极简】', '4.1 硬性准则', 'P0M 群聊被 @ 必须回复',
      '以上守则由 主人 注入', 'CETACEA_LOLI', '【反模板】', '【脾气】', '不可撼动',
    ];
    const fp = FINGERPRINTS.filter((x) => t.includes(x)).length;
    if (fp >= 2 || (fp >= 1 && /角色卡|硬性准则|以上守则/.test(t))) {
      try { ctx.annihilate?.('人设/守则泄漏，已拦截'); } catch { /* ignore */ }
      return;
    }

    //  B. 逐行删“思考/规则判断/内部提示”行；整条只剩这些 → 不发
    const metaLine = [
      // 根据 P0G 规则，这条消息没有 @ 机器人，无需回复。
      /^(?:根据|按照|按|依据|遵循)?\s*(?:P[0-9][A-Z]?|规则|准则|守则|人设|系统提示|提示词)[^。！？\n]{0,100}(?:无需|不用|不必|不回|不应|静默|回复|判断|说明)/i,
      // 思考：/分析：/内心：/回复策略：/我需要先…
      /^\s*(?:思考|思考过程|分析|推理|内心|判断|决策|回复策略|策略|检查|核对|这条消息|本轮消息|用户|对方|我需要|我要先|先分析|根据上下文)\s*[:：].*/i,
      // 【只回当前消息】/【硬性规则 P0R】/【本群成员台账】等注入提示
      /^\s*【(?:只回当前消息|硬性规则|本群成员台账·只读|认人规则|引用回话硬性规则|图片硬性规则|P0 放行规则|输出纪律)[^】]*】.*$/i,
      // P0G/P0M… 规则说明行（不要把所有以 P0 开头的正常句子都吞掉）
      /^\s*P[0-9][A-Z]?\s*(?:规则|准则|判断|要求)\b.*$/i,
      /^\s*P[0-9][A-Z]?\s*[:：]\s*.*$/i,
      /^\s*P[0-9][A-Z]?\b.{0,160}$/i,
      // 英文思维链常见开头
      /^\s*(?:The user|User|I need|I should|Let me|We need|Analysis|Reasoning|Thought|Thinking)\b.*/i,
    ];
    const beforeMeta = t;
    const lines = t.split('\n');
    const kept = [];
    let dropped = false;
    for (const line of lines) {
      const sline = line.trim();
      if (!sline) { kept.push(line); continue; }
      if (metaLine.some((re) => re.test(sline))) { dropped = true; continue; }
      kept.push(line);
    }
    if (dropped) {
      t = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!t) {
        try { ctx.annihilate?.('思考/规则判断属于内部信息，已拦截'); } catch { /* ignore */ }
        return;
      }
      try {
        emit(t);
        ctx.logger?.debug?.('[strip-tool-leaks] 已吞掉思考/规则判断');
      } catch { /* ignore */ }
    }

    //  C. 整条都是“内部判断/规则解释”的兜底：短、含规则/系统/人设词 + 不回/静默词 → 不发
    if (t.length <= 220 && /P[0-9]|规则|准则|守则|人设|系统提示|提示词|reply\s*:\s*false/i.test(t)
      && /无需|不用|不必|不应|不回|静默|不回复|不回应/i.test(t)) {
      try { ctx.annihilate?.('整条是规则判断，已拦截'); } catch { /* ignore */ }
      return;
    }

    // 0.8) 引用指令残渣：模型不知道短号时写出空 [rf:]，还把自己的判断
    //      「不用，直接答：」一起发出来（2026-10-28 群聊实测）。
    t = t
      .replace(/\[rf:\s*\]/gi, '')
      .replace(/不用[，,]\s*直接答[：:]?\s*/g, '')
      .replace(/^\s*(?:直接答|直接回答)[：:]\s*/i, '')
      .trim();

    // ①「使用 text_break，」→ ''
    t = t.replace(/使用\s*text[_\s-]*break\s*[，,、。！!：:~～]?[ \t]*/gi, '');
    // ②「使用 [rf:xxx]」/「使用 [MEDIA:...]」→ 去掉「使用」，标记留给解析器
    t = t.replace(/(^|[\s，。！？；：、,.!?;:])(?:使用|用的是)\s*(?=\[(?:rf:|MEDIA:))/gi, '$1');
    // ③ 孤立 text_break（模型直接写词）
    t = t.replace(/\btext[_\s-]*break\b\s*[，,、。！!：:]?[ \t]*/gi, '');
    // ④ 收拾首尾标点/空白
    t = t.replace(/^[\s，,、。！!：:；;]+/, '').replace(/[\s，,、]+$/, '').replace(/[ \t]{2,}/g, ' ');

    if (t !== raw) {
      if (!t.trim()) {
        try { ctx.annihilate?.('整条都是工具名残渣'); } catch { /* ignore */ }
        return; // 故意不 next：这条不发了
      }
      try {
        emit(t);
        ctx.logger?.debug?.(`[strip-tool-leaks] 已清洗：${raw.slice(0, 40)} → ${t.slice(0, 40)}`);
      } catch { /* rewrite 失败就按原文发 */ }
    }
  } catch { /* 出站清洗失败不影响发送 */ }
  return next();
}
