/**
 * aab-file-to-attachment — 群文件落到 DSH 原生附件仓库，再把真实路径交给模型
 * （2026-11-15 新增，根治「群里发的文件她读不了」）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要这个扩展（三层问题，逐层说）
 *
 * ① **QQ 文件链接是短命的**。实测群里那个 545KB 的 .md，URL 是
 *    `https://njc-download.ftn.qq.com/ftn_handler/...`，十几分钟后再取就 **HTTP 404**。
 *    上游 `transport/attachment.js` 那套 `downloadFileAttachments()` 确实存在，
 *    但它的落点是 `{cwd}/.qqbot/attachments/<日期>/` —— **临时目录、无校验、无去重**，
 *    而且实测这个目录从没被创建过（下载没跑通/失败），模型最终只拿到一个会过期的 URL。
 *
 * ② **DSH 宿主本来就有正经的附件仓库**：`ctx.get('attachments')` 是
 *    `@deepseek-ai/dsh-attachment-local` 提供的 `attachments` 服务，特性：
 *      · **内容寻址**（sha256）⇒ 同一份文件只存一次，重名不冲突
 *      · **逐字节原样保存**（verbatim）⇒ .md / .pdf / .zip 都不会被改写
 *      · **fsync 链持久化** ⇒ 重启后仍在，不会随着 QQ 链接过期而失效
 *      · **读取时校验摘要与长度** ⇒ 文件坏/被截断会明确报错，不会给半份内容
 *      · `fileHostPath(ref)` 能把引用映射成**宿主绝对路径**给模型
 *    这正是"群文件该怎么存"的标准答案，没有理由再自己造一套。
 *
 * ③ **模型侧拿到的文案是宿主现成的**：把 `{ type:'file', attachment: ref }`
 *    放进会话事件后，`@deepseek-ai/dsh-llm` 会渲染成
 *    `[File "x.md" (545000 bytes, sha256:abcdef12): verbatim read-only copy saved at
 *      "/…/attachments/v1/files/…/x.md". Read that path with your file tools …]`
 *    —— 即"用你的文件工具读这个路径"。**前提是模型手里有读文件的工具**，
 *    所以本扩展同时负责把路径登记给工具守卫（见下）。
 *
 * ── 红线与边界 ────────────────────────────────────────────────────────────
 *   · **只在「本条消息带文件附件」时工作**，不扫历史、不翻目录。
 *   · 只处理**本次消息附带**的文件；引用消息里的文件不在范围内（QQ 给不出原文件）。
 *   · 单文件上限 20MB（与上游 MAX_DOWNLOAD_BYTES 一致；更大的文件只登记元信息）。
 *   · 下载失败 → 只把「有这个名字/大小的文件，但取不到内容」如实告诉模型，
 *     **绝不编造内容**。
 *   · 全程不写业务数据目录，只往宿主附件仓库写（那是它的本职）。
 */
import { appendLogRotating } from '../lib/log-rotate.mjs';
import { join } from 'node:path';
import { calledByCurrentText } from '../lib/name.mjs';

export const name = 'file-to-attachment';

/** 单文件下载上限：与上游 attachment.js 的 MAX_DOWNLOAD_BYTES 对齐 */
const MAX_BYTES = 20 * 1024 * 1024;
/** 单条消息最多处理几个文件（防止一次发十个大文件把入站链拖死） */
const MAX_FILES = 3;
/** 下载超时：QQ 文件服务器偶发慢，给足但别拖死入站 */
const FETCH_TIMEOUT_MS = 20_000;

/** 本会话「本次可读的文件路径」登记表（供 hooks/zz-tool-security-guard 放行 read 用） */
const FILE_KEY = Symbol.for('qqbot.current-file-paths');
const SENDER_KEY = Symbol.for('qqbot.current-sender');

function targetKey(ctx) {
  const scope = String(ctx?.scope ?? '');
  const m = ctx?.message ?? {};
  const peer = scope === 'group'
    ? (m.groupOpenid ?? ctx?.replyTarget?.targetId ?? '')
    : (m.senderId ?? ctx?.replyTarget?.targetId ?? '');
  return `${scope}:${peer}`;
}

/** 判断附件是不是「文件」（图片/语音/视频不算 —— 它们各有专门通道） */
function isFile(att) {
  const ct = String(att?.content_type ?? att?.contentType ?? '').toLowerCase().trim();
  if (ct === 'voice' || ct.startsWith('audio/')) return false;
  if (ct === 'image' || ct.startsWith('image/')) return false;
  if (ct === 'video' || ct.startsWith('video/')) return false;
  // 宽高存在 ⇒ 图片（QQ 只在图片上给这两个字段）
  if (att?.width && att?.height) return false;
  const hay = `${att?.filename ?? ''} ${att?.url ?? ''}`;
  if (/\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)(?:[?#\s]|$)/i.test(hay)) return false;
  if (/\.(mp4|mov|m4v|webm|avi|mkv)(?:[?#\s]|$)/i.test(hay)) return false;
  if (/\.(silk|amr|mp3|wav|ogg|opus|m4a|aac)(?:[?#\s]|$)/i.test(hay)) return false;
  if (/[?&]appid=(1403|1406|1407|1415)(?:[&#]|$)/i.test(String(att?.url ?? ''))) return false;
  return true;
}

function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function diag(root, row) {
  try {
    appendLogRotating(join(root, '.qqbot-extensions', 'data', 'file-to-attachment.jsonl'), JSON.stringify(row) + '\n', 256 * 1024);
  } catch { /* ignore */ }
}

/**
 * ★ 入站 trace 开关（2026-11-23：热路径日志收敛）
 *
 * 官方契约（docs/extension-contract.md:681-682）写得很明白：**入站是热路径，两个挂点
 * 每条消息都跑一遍**，别在这儿发消息、打接口、做长任务。而 `diag()` 走
 * `appendLogRotating` → `appendFileSync`，是**同步写盘**：每条消息都写一次，
 * 实测 `file-to-attachment.jsonl` 已经滚到 222KB（另有 .1 262KB），394 行里 337 行
 * 是纯 `trace:'enter'` 的空转记录 —— 对「文件为什么不变成附件」这个问题毫无信息量。
 *
 * 因此 trace 默认只跟**文件线索**走（见 traceWanted）；需要无条件全量 trace 时，
 * 起进程前设 `QQBOT_FILE_TRACE=1`（或 true/yes/on），排查完即关。
 * ⚠️ 这里读 `process.env` 是纯内存操作，不产生任何 I/O。
 */
const TRACE_ON = (() => {
  try {
    return /^(1|true|yes|on)$/i.test(String(process.env.QQBOT_FILE_TRACE ?? '').trim());
  } catch { return false; }
})();

/**
 * 本条消息「是否有文件线索」的廉价判定 —— **纯内存，不落盘、不抛**。
 * 只用来决定要不要写 trace，不参与任何业务判断（业务判定在下面的主干里照旧做）。
 * 任何读取异常都当作「没有」，保证热路径既不写盘也不会抛。
 */
function traceWanted(ctx) {
  if (TRACE_ON) return true;
  try {
    const a = ctx?.message?.attachments;
    if (Array.isArray(a) && a.length > 0) return true;
  } catch { /* cordis/SDK 的 getter 在某些上下文里读取即抛 → 当没有 */ }
  try {
    const q = ctx?.state?.quote;
    if (Array.isArray(q?.attachments) && q.attachments.length > 0) return true;
  } catch { /* ignore */ }
  return false;
}

/** 把 URL 流式下载成 Buffer（带超时 + 大小上限） */
async function fetchBytes(url, maxBytes) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'dsh-qqbot-file' } });
    if (!resp?.ok) throw new Error(`HTTP ${resp?.status}`);
    // 先看声明大小（QQ 一般给 content-length）
    const cl = Number(resp.headers?.get?.('content-length') ?? 0);
    if (cl && cl > maxBytes) throw new Error(`too-large-declared:${cl}`);
    // 流式累积，超限立即中止（不把整个大文件读进内存）
    const reader = resp.body?.getReader?.();
    if (!reader) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`too-large:${buf.length}`);
      return buf;
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`too-large:${total}`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把一批字节交给宿主附件仓库，返回 durable 引用。
 * 用 `saveFileStream`（有则优先，逐块写入不占内存）→ 退 `saveFile` → 都不可用返回 null。
 */
async function saveToAttachments(attachmentsSvc, bytes, filename) {
  // ① 流式接口：把 Buffer 切成块喂进去（宿主会边写边算 sha256）
  if (typeof attachmentsSvc?.saveFileStream === 'function') {
    try {
      async function* chunks() {
        const CHUNK = 64 * 1024;
        for (let i = 0; i < bytes.length; i += CHUNK) yield bytes.subarray(i, i + CHUNK);
      }
      return await attachmentsSvc.saveFileStream({ data: chunks(), name: filename });
    } catch (err) {
      // 流式失败（比如某些后端不支持）→ 退回整体保存
      if (!/UNSUPPORTED/.test(String(err?.code ?? err?.message ?? ''))) throw err;
    }
  }
  // ② 整体保存
  if (typeof attachmentsSvc?.saveFile === 'function') {
    return await attachmentsSvc.saveFile({ data: bytes, name: filename });
  }
  return null;
}

/**
 * 从宿主 ctx 取 attachments 服务。
 *
 * 探测顺序（每一路都单独 try —— cordis 的 get 在未 inject 时**读取即抛**）：
 *   ① `caps.kernel`（插件 cordis ctx，官方契约里的"遥控器"）
 *   ② `ctx.kernel`（同上的平铺形态，部分扩展点会平铺）
 *   ③ `ctx.attachments`（万一将来直接挂到 ctx 上）
 *
 * ⚠️ 取不到时**必须留痕**：否则表现为"文件消息只回一句取不到内容"，查不出是
 *   服务没挂、还是作用域不对。诊断写到 file-to-attachment.jsonl，只在第一次记（防刷屏）。
 */
let probeLogged = false;
/** 最近一次探测失败的原因（注入文本里会带上，便于群里直接定位） */
let lastProbeErrors = [];
function attachmentsOf(ctx, root) {
  const attempts = [
    // ① 插件 cordis ctx（官方契约的"遥控器"）
    ['caps.kernel', () => ctx?.caps?.kernel?.get?.('attachments')],
    // ② 平铺形态
    ['ctx.kernel', () => ctx?.kernel?.get?.('attachments')],
    // ③ 经由本条消息所属的宿主 agent（agent.ctx 是会话作用域，服务链一定通）
    ['resolveAgent', () => {
      const a = typeof ctx?.resolveAgent === 'function' ? ctx.resolveAgent(ctx) : null;
      return a?.ctx?.get?.('attachments');
    }],
    // ④ 直接挂在 ctx 上（未来形态）
    ['ctx.attachments', () => ctx?.attachments],
  ];
  const errors = [];
  for (const [label, get] of attempts) {
    try {
      const v = get();
      if (v) {
        if (!probeLogged) {
          probeLogged = true;
          diag(root, { at: new Date().toISOString(), probe: 'ok', via: label, hasSaveFileStream: typeof v.saveFileStream === 'function', hasFileHostPath: typeof v.fileHostPath === 'function' });
        }
        return v;
      }
      errors.push(label + ':empty');
    } catch (err) {
      errors.push(label + ':' + (err instanceof Error ? err.message : String(err)).slice(0, 60));
    }
  }
  if (!probeLogged) {
    probeLogged = true;
    diag(root, {
      at: new Date().toISOString(),
      probe: 'fail',
      errors,
      hasCaps: Boolean(ctx?.caps),
      hasKernel: Boolean(ctx?.caps?.kernel ?? ctx?.kernel),
      resolveAgent: typeof ctx?.resolveAgent,
      // ⚠️ 关键诊断：resolveAgent 到底返不返回 agent、agent 有没有 ctx、ctx 能不能 get
      agentProbe: (() => {
        try {
          const a = typeof ctx?.resolveAgent === 'function' ? ctx.resolveAgent(ctx) : null;
          let got = 'n/a';
          try { got = a?.ctx?.get?.('attachments') ? 'OK' : 'null'; } catch (e2) { got = 'throw:' + (e2 instanceof Error ? e2.message : String(e2)).slice(0, 40); }
          return { hasAgent: Boolean(a), hasCtx: Boolean(a?.ctx), getResult: got };
        } catch (e2) {
          return { err: String(e2).slice(0, 80) };
        }
      })(),
    });
  }
  // 把失败原因带出去 → 注入文本会写明"为什么"，群里直接能看见，不用翻日志
  lastProbeErrors = errors;
  return null;
}

/**
 * 取本条消息的引用对象 —— **必须用 `ctx.state.quote`，不能用 `ctx.quoted()`**。
 *
 * ⚠️⚠️ 2026-11-15 实测踩中（trace 现场）：
 *   `ctx.quoted()` 返回的是上游 `quotedOf()` **裁剪过**的对象，只有
 *   `{ text, fromSelf, id }` —— **attachments 被丢掉了**：
 *     · trace 实测 quoted() → keys: ["text","fromSelf","id"]，没有 attachments
 *     · 而 ctx.state.quote → keys: ["refKey","source","rawContent","attachments","text"]（有！）
 *   所以想拿"被引用的文件/图片"，只能读原始 `ctx.state.quote`。
 *   上游自己渲染引用块时也是这么干的（transport/inbound.js 的 buildQuoteBlock 直接吃
 *   `state.quote` 的 attachments），不是通过 quoted()。
 *
 * `quoted()` 的用途是"**引用的是哪句话、是不是她说的**"（text + fromSelf），
 * 它天生不为附件服务 —— 这两个用途要分开，别混用。
 */
function quoteOf(ctx) {
  try {
    const raw = ctx?.state?.quote;
    if (raw && typeof raw === 'object') return raw;
  } catch { /* ignore */ }
  // 兜底：极少数场景 state.quote 没设，才退回 quoted()（虽然它没有 attachments）
  try {
    if (typeof ctx?.quoted === 'function') return ctx.quoted();
  } catch { /* ignore */ }
  return undefined;
}

/** 引用消息里的文件附件（★ 群文件场景：URL 藏在 ctx.state.quote.attachments 里） */
function quoteFileAttachments(ctx) {
  const q = quoteOf(ctx);
  const list = Array.isArray(q?.attachments) ? q.attachments : [];
  return list.filter(isFile);
}

export async function onInbound(ctx, next) {
  const _root = String(ctx?.dataRoot || '');
  // ★ trace（原为无条件，每条消息写一次盘）：只在**本条消息确实带文件线索**或显式开了
  //   QQBOT_FILE_TRACE 时才落盘。普通文本消息在这里零 I/O、零反射遍历。
  //   原意保留：诊断「文件为什么没变成附件」，所以真正的文件消息仍然留下完整现场。
  if (traceWanted(ctx)) {
    try {
      diag(_root, {
        at: new Date().toISOString(),
        trace: 'enter',
        scope: String(ctx?.scope ?? ''),
        mentioned: ctx?.platform?.mentioned === true,
        // 逐层安全读取：cordis/SDK 的 getter 在某些上下文里**读取即抛**，整串 ?. 会被外层 catch 吞掉
        msgAtts: (() => {
          try {
            const m = ctx?.message;
            if (!m) return 'no-message';
            try {
              const a = m.attachments;
              return Array.isArray(a) ? a.length : (a === undefined ? 'undefined' : typeof a);
            } catch (e2) { return 'atts-throw:' + String(e2?.message ?? e2).slice(0, 40); }
          } catch (e2) { return 'msg-throw:' + String(e2?.message ?? e2).slice(0, 40); }
        })(),
        // 诊断：ctx 到底长什么样（键名 + message 的键名）
        ctxKeys: (() => { try { return Object.keys(ctx || {}).slice(0, 30); } catch { return null; } })(),
        msgKeys: (() => { try { return ctx?.message ? Object.keys(ctx.message).slice(0, 30) : null; } catch { return null; } })(),
        quoteKeys: (() => { try { const q = ctx?.state?.quote; return q ? Object.keys(q).slice(0, 20) : null; } catch { return null; } })(),
        hasQuoted: typeof ctx?.quoted,
        hasResolveAgent: typeof ctx?.resolveAgent,
        capsKernel: Boolean(ctx?.caps?.kernel),
        ctxKernel: Boolean(ctx?.kernel),
        sessionId: (() => { try { return String(ctx?.sessionId ?? ''); } catch { return '?'; } })(),
      });
    } catch { /* ignore */ }
  }
  try {
    const scope = String(ctx?.scope ?? '');
    if (scope !== 'group' && scope !== 'c2c') return next();
    // 群聊：必须 @ 或叫名字才处理（与图片扩展同口径 —— 群里不能因为"有人发了文件"就静默读盘）
    if (scope === 'group' && !(ctx?.platform?.mentioned === true || calledByCurrentText(ctx))) return next();

    const atts = Array.isArray(ctx?.message?.attachments) ? ctx.message.attachments : [];
    // ★ 2026-11-15（路径 2）：除了「本条消息带的文件」，**引用消息里的文件**也要处理。
    //   起因：群里发的是「群文件」——QQ 不会在聊天里推附件消息，只会让用户**引用它**来问。
    //   引用时 URL 落在 `q.attachments` 里（实测带 fname= 参数，当时有效）。
    //   两条来源合并去重（按 URL），本条优先。
    const _own = atts.filter(isFile);
    const _quoted = quoteFileAttachments(ctx);
    const files = [..._own, ..._quoted];
    // ★ 关键诊断：本条附件数 / 引用文件数 / 两者命中情况（这是"群文件到底怎么进来的"唯一证据）
    //   ⚠️ 同样只在**确有文件线索**时写：c2c 场景下普通消息也会走到这里，
    //   无条件写等于把热路径的写盘从 1 处变成 2 处。真的带文件/带引用附件时才有信息量。
    if (traceWanted(ctx)) {
      try {
        const q = quoteOf(ctx);
        diag(_root, {
          at: new Date().toISOString(),
          trace: 'files',
          own: _own.length,
          quoted: _quoted.length,
          quoteHasAtts: Array.isArray(q?.attachments) ? q.attachments.length : (q?.attachments === undefined ? 'undefined' : typeof q?.attachments),
          quoteTextLen: String(q?.text ?? '').length,
          quoteKeys: q ? Object.keys(q).slice(0, 15) : null,
          quotedNames: _quoted.map((a) => String(a?.filename ?? '?')).slice(0, 5),
        });
      } catch { /* ignore */ }
    }
    if (files.length === 0) return next();

    const root = String(ctx.dataRoot || '');
    const svc = attachmentsOf(ctx, root);
    const lines = [];
    const readable = [];

    for (const att of files.slice(0, MAX_FILES)) {
      const fname = String(att?.filename ?? 'file');
      const url = String(att?.url ?? '').trim();
      const size = Number(att?.size ?? 0);

      // 无 URL / 超限 / 服务不可用 → 只如实登记元信息，不猜内容
      if (!url) {
        lines.push(`[文件] ${fname}（${humanSize(size)}）：QQ 没给下载地址，取不到内容。`);
        diag(root, { at: new Date().toISOString(), file: fname, result: 'no-url' });
        continue;
      }
      if (size > MAX_BYTES) {
        lines.push(`[文件] ${fname}（${humanSize(size)}）：超过 ${humanSize(MAX_BYTES)} 上限，未下载。`);
        diag(root, { at: new Date().toISOString(), file: fname, result: 'too-large-meta', size });
        continue;
      }
      if (!svc) {
        // ★ 把探测到的**具体原因**一并告诉模型/群里 —— 免得只看到"取不到内容"却不知道卡在哪
        const why = (lastProbeErrors || []).join(' / ') || '未知';
        lines.push(`[文件] ${fname}（${humanSize(size)}）：宿主附件服务不可用（${why}），取不到内容。`);
        diag(root, { at: new Date().toISOString(), file: fname, result: 'no-attachments-service', why });
        continue;
      }

      let bytes;
      try {
        bytes = await fetchBytes(url, MAX_BYTES);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        lines.push(`[文件] ${fname}（${humanSize(size)}）：下载失败（${why}），取不到内容。`);
        diag(root, { at: new Date().toISOString(), file: fname, result: 'download-fail', err: why });
        continue;
      }

      let ref = null;
      try {
        ref = await saveToAttachments(svc, bytes, fname);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        diag(root, { at: new Date().toISOString(), file: fname, result: 'save-fail', err: why });
      }

      let hostPath = '';
      try {
        hostPath = ref ? String(svc.fileHostPath?.(ref) ?? '') : '';
      } catch { /* 后端非文件型 */ }

      if (hostPath) {
        readable.push(hostPath);
        lines.push(
          `[文件] 《${fname}》${humanSize(bytes.length)}，已存入本机只读附件仓库：${hostPath}\n`
          + '  → 要看内容就用 read 工具读这个路径（只读副本；要改先复制到别处）。',
        );
        diag(root, { at: new Date().toISOString(), file: fname, result: 'ok', size: bytes.length, hostPath });
      } else {
        // 存进去了但后端不给宿主路径（非文件型后端）→ 如实说
        lines.push(`[文件] 《${fname}》${humanSize(bytes.length)} 已存入附件仓库，但当前执行环境拿不到可读路径，读不了内容。`);
        diag(root, { at: new Date().toISOString(), file: fname, result: 'no-host-path', size: bytes.length });
      }
    }

    if (lines.length === 0) return next();

    // 登记「本次可读的文件路径」—— 供 hooks/zz-tool-security-guard 放行 read
    try {
      let m = globalThis[FILE_KEY];
      if (!(m instanceof Map)) { m = new Map(); globalThis[FILE_KEY] = m; }
      m.set(targetKey(ctx), { at: Date.now(), paths: readable.slice() });
      if (m.size > 200) {
        const now = Date.now();
        for (const [k, v] of m) if (!v || now - Number(v.at ?? 0) > 30 * 60 * 1000) m.delete(k);
      }
    } catch { /* ignore */ }

    // 同时标记「本次有文件」，让 guard 知道 read 该放行（与图片的 hasImage 同款）
    try {
      const sm = globalThis[SENDER_KEY];
      if (sm instanceof Map) {
        const e = sm.get(targetKey(ctx));
        if (e) e.hasFile = true;
      }
    } catch { /* ignore */ }

    // 注入上下文：rewrite 把文件行追加到本条正文（走正常入站链，历史里也留得下）
    try {
      await ctx.rewrite?.({
        text: `${String(ctx.text ?? '').trim()}\n${lines.join('\n')}`.trim(),
        reason: '文件：存进 DSH 附件仓库并交出真实路径',
      });
    } catch { /* ignore */ }
  } catch { /* 任何异常都不能影响主链 */ }
  return next();
}
