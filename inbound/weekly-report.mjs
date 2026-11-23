/**
 * weekly-report.mjs — 好感度周报：手动触发 + 每周自动推送
 *
 * 1) 手动：群里 @机器人 /周报（私聊直接 /周报）→ 现场跑 lib/scripts/weekly-report.mjs，回发短版摘要
 * 2) 自动：每周一（可配）08:00 后第一条入站消息触发一次，把摘要主动发到配置群
 *
 * 配置：{dataRoot}/.qqbot-extensions/data/weekly-report-config.json
 *   { "enabled": true, "autoDay": 1, "autoHour": 8, "autoGroupId": "群openid" }
 *   autoDay: 1=周一 … 7=周日（0 也当周日）
 * 状态：{dataRoot}/.qqbot-extensions/data/weekly-report-state.json（记录 lastAuto，防重复）
 *
 * ★ 2026-11-20：生成脚本迁入包内 `lib/scripts/weekly-report.mjs`（原 {workspace}/Bot/scripts/），
 *   使命中包自包含；dataRoot / out 全部显式传参，不依赖脚本内默认值。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withAtBack } from '../lib/pure/at-reply.mjs';
import { addressed } from '../lib/name.mjs';

export const name = 'weekly-report';

import { DATA_ROOT as PACK_DATA_ROOT, EXT_DATA, EXT_ROOT } from '../lib/pack-paths.mjs';

const DATA_ROOT = PACK_DATA_ROOT;
const BOT_ROOT = join(DATA_ROOT, '..');
const SCRIPT = join(EXT_ROOT, 'lib', 'scripts', 'weekly-report.mjs');
const OUT_DIR = join(BOT_ROOT, '周报');
const DATA_DIR = EXT_DATA;
const CONFIG_FILE = join(DATA_DIR, 'weekly-report-config.json');
const STATE_FILE = join(DATA_DIR, 'weekly-report-state.json');

const DEFAULT_CONFIG = {
  enabled: true,
  autoDay: 1,
  autoHour: 8,
  // ★ 开源规范：不写死真实群号。留空 = 关闭自动周报，由用户配置（BNN_WEEKLY_GROUP）
  autoGroupId: process.env.BNN_WEEKLY_GROUP || '',
};

const runFile = promisify(execFile);
let running = null;
let nodeBinCache = null;

/** 找到真正能跑的 node 可执行文件（插件进程里 process.execPath 是 linker64，不能直接用） */
async function nodeBin() {
  if (nodeBinCache) return nodeBinCache;
  try {
    const r = await runFile('sh', ['-c', 'command -v node'], { timeout: 5000 });
    const p = String(r.stdout || '').trim();
    if (p) { nodeBinCache = p; return p; }
  } catch { /* next */ }
  const cands = [
    process.env.DSH_NODE, process.env.NODE,
    `${process.env.PREFIX || '/data/data/com.dsharnessmobile.shell/files/usr'}/bin/node`,
    '/usr/bin/node', '/usr/local/bin/node', '/system/bin/node',
  ].filter(Boolean);
  for (const c of cands) {
    try { await runFile(c, ['-v'], { timeout: 8000 }); nodeBinCache = c; return c; } catch { /* next */ }
  }
  nodeBinCache = 'node';
  return 'node';
}

function readJson(p, d) {
  try { return { ...d, ...JSON.parse(readFileSync(p, 'utf8')) }; } catch { return { ...d }; }
}
function writeJson(p, v) {
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 1), 'utf8');
    renameSync(tmp, p);
  } catch { /* ignore */ }
}

function shNow() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return {
    ymd: d.toISOString().slice(0, 10),
    day: d.getUTCDay(),          // 0=周日,1=周一…
    hour: d.getUTCHours(),
  };
}

function newestSummary() {
  try {
    const files = readdirSync(OUT_DIR)
      .filter((f) => /^QQBot周报-.*-qq\.txt$/.test(f))
      .map((f) => ({ f, m: statSync(join(OUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return '';
    return readFileSync(join(OUT_DIR, files[0].f), 'utf8').trim();
  } catch { return ''; }
}

/** 跑脚本并取最新短版摘要（带并发保护） */
async function generate() {
  if (running) return running;
  running = (async () => {
    try {
      const bin = await nodeBin();
      const opts = { cwd: BOT_ROOT, timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
      // 显式传参：脚本位置变了也能跑，且不依赖脚本内任何默认路径
      const args = [SCRIPT, `--dataRoot=${DATA_ROOT}`, `--out=${OUT_DIR}`];
      try {
        await runFile(bin, args, opts);
      } catch (e1) {
        // 兜底：用 shell 的 node（PATH 与插件进程可能不同）
        await runFile('sh', ['-c', `node ${args.map((a) => JSON.stringify(a)).join(' ')}`], opts);
      }
      return { ok: true, text: newestSummary() };
    } catch (e) {
      return { ok: false, err: String(e?.stderr || e?.message || e) };
    } finally {
      running = null;
    }
  })();
  return running;
}

async function sendTo(ctx, gid, text) {
  const gidStr = String(gid || '').trim();
  if (!gidStr) return false;
  // 2026-11-05 修复：`ctx.bot.send` / `ctx.bot.sendText` 在入站 ctx 里**根本不存在**
  //   ⇒ 两条分支是死代码，实际一直回落到 `ctx.markdown()` = 发到「当前会话」，
  //   `autoGroupId` 因此被忽略（周一 8 点后哪个群先说话，周报就发到哪个群）。
  //   改为官方 v2 接口**显式指定目标群**（caps.api 自带 token），当前会话只作最后兜底。
  const api = ctx?.caps?.api ?? ctx?.api;
  const postGroup = async (body) => {
    if (typeof api !== 'function') return false;
    const r = await api(`/v2/groups/${encodeURIComponent(gidStr)}/messages`, { method: 'POST', body });
    const httpOk = Boolean(r && r.ok !== false);
    const data = r?.data;
    // caps.api 的 `ok` 只代表 HTTP 成功；再看 data 里有没有明确错误码
    const rejected = Boolean(data && typeof data === 'object'
      && Number.isFinite(Number(data.code)) && Number(data.code) !== 0);
    return httpOk && !rejected;
  };
  // ① markdown 卡片（周报带排版）
  try {
    if (await postGroup({ msg_type: 2, markdown: { content: String(text) } })) return true;
  } catch { /* fallthrough */ }
  // ② 纯文本重试（markdown 受模板/主动消息窗口限制时的退路）
  try {
    if (await postGroup({ msg_type: 0, content: String(text) })) return true;
  } catch { /* fallthrough */ }
  try {
    if (typeof ctx?.markdown === 'function') return await ctx.markdown(text);
  } catch { /* ignore */ }
  return false;
}

function stripMention(text) {
  return String(text ?? '').replace(/^(\s*<@[^>]+>)+\s*/g, '').trim();
}


/**
 * 命令/卡片已被扩展完全处理 → 消灭这条消息再放行（链会停在消灭处）。
 * ★ 2026-10-20 修复：引擎对「主人发送者」有强制兜底放行（白名单最高优先），
 *   只 `return` 不调 next 会让主人的命令又被 mentionGate/AI 处理一遍 → 卡片+AI 重复回复。
 *   用 annihilate({ownerAck:true}) 声明"已另行处置"，再 next() 让引擎正常收尾。
 */
async function consumeInbound(ctx, next, reason) {
  try {
    if (typeof ctx?.annihilate === 'function') {
      await ctx.annihilate({ reason, ownerAck: true });
    }
  } catch { /* 失败就按旧行为：直接停链 */ }
  return next();
}

async function manual(ctx, next) {
  const raw = String(ctx.text ?? '');
  const cmd = stripMention(raw.replace(/^\s*★主人\s*\n/, '')).replace(/^／/, '/').trim();
  if (!/[\/／]\s*周报\s*$/.test(cmd) && cmd !== '周报') return next();
  // 2026-10-21 安全：/周报 会起 120s 子进程，群友不该能触发；只给主人（owners 未配置时 fail-open）。
  const _owners = Array.isArray(ctx?.caps?.owners) ? ctx.caps.owners : (Array.isArray(ctx?.owners) ? ctx.owners : []);
  const _isOwner = ctx?.isOwner ?? ctx?.caps?.user?.isOwner ?? ctx?.user?.isOwner;
  if (_owners.length && _isOwner !== true) {
    try { if (typeof ctx?.markdown === 'function') await ctx.markdown(withAtBack(ctx, '你还没有该权限哦')); } catch { /* ignore */ }
    return consumeInbound(ctx, next, '周报 非主人');
  }
  if (typeof ctx?.markdown === 'function') {
    await ctx.markdown(withAtBack(ctx, '⏳ 正在生成周报，稍等喔……'));
  }
  const res = await generate();
  if (!res.ok) {
    const msg = `❌ 周报生成失败：${String(res.err).slice(0, 200)}`;
    if (typeof ctx.markdown === 'function') await ctx.markdown(withAtBack(ctx, msg)); else await sendTo(ctx, ctx?.message?.groupOpenid, withAtBack(ctx, msg));
    return consumeInbound(ctx, next, '周报 生成失败已回执');
  }
  const text = res.text || '（没有取到摘要，去 周报/ 目录看吧）';
  try {
    if (typeof ctx.markdown === 'function') await ctx.markdown(withAtBack(ctx, text));
    else if (ctx?.scope === 'group') await sendTo(ctx, ctx.message.groupOpenid, withAtBack(ctx, text));
  } catch { /* ignore */ }
  return consumeInbound(ctx, next, '周报 已发送');
}

export async function onInbound(ctx, next) {
  try {
    const raw = String(ctx.text ?? '');
    const cmd = stripMention(raw).replace(/^／/, '/').trim();

    // ── 手动 /周报（容忍 ★主人/@ 前缀，群里不强制 @）──
    const reportCmd = stripMention(String(ctx.text ?? '').replace(/^\s*★主人\s*\n/, '')).replace(/^／/, '/').trim();
    if (/[\/／]\s*周报\s*$/.test(reportCmd) || reportCmd === '周报') {
      // ★ 2026-10-27（主人拍板）：群内「周报」也必须 @/叫名字；私聊保持原样。
      if (ctx.scope === 'group' && !addressed(ctx)) return next();
      return await manual(ctx, next);
    }

    // ── 自动：周几 + 小时后第一条消息触发一次 ──
    const cfg = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    if (cfg.enabled) {
      const now = shNow();
      const wantDay = Number(cfg.autoDay) === 7 ? 0 : Number(cfg.autoDay);
      const state = readJson(STATE_FILE, { lastAuto: '' });
      if (now.day === wantDay && now.hour >= Number(cfg.autoHour) && state.lastAuto !== now.ymd) {
        writeJson(STATE_FILE, { ...state, lastAuto: now.ymd });
        const gid = String(cfg.autoGroupId || '').trim();
        // 异步跑，不阻塞当前消息
        generate().then((res) => {
          if (!res.ok) return;
          const text = res.text;
          if (!text) return;
          if (gid) sendTo(ctx, gid, text).catch(() => {});
          else if (ctx?.scope === 'group') sendTo(ctx, ctx.message.groupOpenid, text).catch(() => {});
        }).catch(() => {});
      }
    }
  } catch { /* ignore */ }
  return next();
}
