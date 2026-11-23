/**
 * game-command — 三个玩法命令的**共享外壳**（2026-11-09，R4.5）
 *
 * 三个命令（猜拳/骰子/抽签）除了「调哪个 core 函数」之外，其余完全一样：
 *   ① 取 dataRoot → 读配置（缺失自动生成默认）
 *   ② 冷却检查（同人同群 2 秒，key 带命令名互不干扰）
 *   ③ 调 core → 返回文本
 *
 * 把它们抽到这里，三个命令文件各剩 15 行 —— 改冷却逻辑只改一处。
 *
 * 纪律：任何 IO 失败都降级为默认配置（**绝不因为配置文件坏掉让命令失效**）。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createCooldown, cooldownText, resolveConfig, DEFAULT_CONFIG } from './pure/game-core.mjs';

/** 进程内冷却器（模块级单例，三个命令共用；key 里带命令名区分）。 */
let cooldown = null;

/** 配置文件名（相对 `.qqbot-extensions/data`）。 */
const CONFIG_NAME = 'game-config.json';

/** 取扩展数据根。 */
export function dataRootOf(ctx) {
  return String(ctx?.caps?.dataRoot || ctx?.dataRoot || '').trim();
}

/**
 * 读配置；文件不存在或损坏 → 自动写一份默认值（方便主人以后直接改）。
 * 任何失败都回落内存默认值，绝不抛。
 */
export function loadGameConfig(root) {
  if (!root) return resolveConfig(DEFAULT_CONFIG);
  const file = join(root, '.qqbot-extensions', 'data', CONFIG_NAME);
  try {
    return resolveConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch { /* 写不了也无所谓 */ }
    return resolveConfig(DEFAULT_CONFIG);
  }
}

/** 取冷却 key 的 (gid, uid) —— 拿不到就返回空串（此时不做冷却，宁可不管也不误拦）。 */
export function peerOf(ctx) {
  const caps = ctx?.caps ?? {};
  const mc = ctx?.message ?? {};
  return {
    gid: String(caps.peerId ?? mc.groupOpenid ?? mc.group_openid ?? ''),
    uid: String(caps.actorOpenid ?? mc.author?.member_openid ?? mc.author?.user_openid ?? ''),
  };
}

/**
 * 跑一个玩法命令的公共流程。
 *
 * @param ctx      命令上下文
 * @param command  命令名（用于冷却 key，互不干扰）
 * @param play     `(cfg, raw) => string` —— 真正干活的纯逻辑
 */
export function runGameCommand(ctx, command, play) {
  const root = dataRootOf(ctx);
  const cfg = loadGameConfig(root);

  const { gid, uid } = peerOf(ctx);
  if (gid && uid) {
    if (!cooldown) cooldown = createCooldown(cfg);
    const r = cooldown.check(`${command}:${gid}:${uid}`, Date.now());
    if (!r.ok) return cooldownText(r.retryAfterMs);
  }

  const raw = String(ctx?.command?.raw ?? ctx?.rawArgs ?? '').trim();
  return play(cfg, raw);
}

/** 供测试/诊断：当前冷却记录数。 */
export function cooldownSize() {
  return cooldown ? cooldown.size() : 0;
}

/** 供测试：清空冷却。 */
export function resetCooldown() {
  if (cooldown) cooldown.clear();
  cooldown = null;
}
