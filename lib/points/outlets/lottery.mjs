/**
 * outlets/lottery — 抽奖（30 分）2026-11-18 R5.1
 *
 * ── 设计决策（审查后修正）──────────────────────────────────────────────────
 *   原方案想「抽到"她多说一句话"」——技术上无法实现（不能强制模型多说）。
 *
 *   现在的奖励**全部是可编程的**：
 *
 *   | 奖项     | 概率 | 奖励        | 实现        |
 *   |----------|------|-------------|-------------|
 *   | 谢谢参与 | 40%  | 无          | 纯文本      |
 *   | 一张图   | 30%  | 图库随机图  | ctx.image   |
 *   | 返 5 分  | 20%  | +5          | pts.refund  |
 *   | 返 25 分 |  8%  | +25         | pts.refund  |
 *   | 大奖     |  2%  | +80         | pts.refund  |
 *
 *   期望值：0 + 0 + 1 + 2 + 1.6 = **4.6 分**
 *   花 30 得 4.6 分 + 30% 概率得一张图 ⇒ 略亏但可接受（抽奖本就是娱乐）
 *
 *   ★ 返分用 `pts.refund`（ledger 记 type='refund'，不算 earn），
 *     这样统计里"赚了多少"不会被抽奖污染。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, WORKSPACE_ROOT } from '../../pack-paths.mjs';
import { IMAGE_ROOT } from '../../dirs.mjs';

const IMAGE_DIRS = [
  IMAGE_ROOT,
  ];

/** 奖项表（概率之和 = 100）。 */
export const PRIZES = [
  { key: 'none', weight: 40, points: 0, label: '谢谢参与', text: '……没中。' },
  { key: 'image', weight: 30, points: 0, label: '一张图', text: '中了张图。拿去。' },
  { key: 'small', weight: 20, points: 5, label: '返 5 分', text: '返你 5 分。' },
  { key: 'medium', weight: 8, points: 25, label: '返 25 分', text: '25 分，收着。' },
  { key: 'jackpot', weight: 2, points: 80, label: '大奖 80 分', text: '……80 分。今天手气可以。' },
];

/**
 * 按权重抽一个奖项。
 * @param {() => number} random
 */
export function drawPrize(random = Math.random) {
  const total = PRIZES.reduce((a, b) => a + b.weight, 0);
  let r = random() * total;
  for (const p of PRIZES) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return PRIZES[0];
}

/** 从图库随机挑一张（拿不到返回 null）。 */
export function pickImage(random = Math.random) {
  const exts = /\.(jpe?g|png|webp|gif)$/i;
  for (const dir of IMAGE_DIRS) {
    if (!existsSync(dir)) continue;
    let files = [];
    try { files = readdirSync(dir).filter((f) => exts.test(f)); } catch { continue; }
    if (files.length === 0) continue;
    return join(dir, files[Math.floor(random() * files.length)]);
  }
  return null;
}

export default {
  id: 'lottery',
  name: '抽奖',
  price: 30,
  enabled: true,
  description: '花 30 分抽一次，可能中图或返分',

  /**
   * @param {{pts:object, openid:string, name:string, gid:string, persona:string, random?:Function}} p
   */
  async run(p) {
    const random = typeof p?.random === 'function' ? p.random : Math.random;
    const prize = drawPrize(random);

    const lines = ['## 🎰 抽奖', ''];

    // ① 返分
    if (prize.points > 0) {
      try {
        await p.pts.refund(p.openid, prize.points, `抽奖:${prize.key}`, p?.name);
      } catch { /* 返分失败不影响文案 */ }
      const bal = (() => { try { return p.pts.balance(p.openid); } catch { return 0; } })();
      lines.push(`**${prize.label}**`);
      lines.push('');
      lines.push(prize.text);
      lines.push('');
      lines.push(`余额 **${bal}**`);
      return { ok: true, text: lines.join('\n'), prize, imagePath: null };
    }

    // ② 图
    if (prize.key === 'image') {
      const img = pickImage(random);
      if (img) {
        lines.push(`**${prize.label}**`);
        lines.push('');
        lines.push(prize.text);
        return { ok: true, text: lines.join('\n'), prize, imagePath: img };
      }
      // 图库空 → 降级为"谢谢参与"
      lines.push('**谢谢参与**');
      lines.push('');
      lines.push('（图库空的，下次给你补。）');
      return { ok: true, text: lines.join('\n'), prize: PRIZES[0], imagePath: null };
    }

    // ③ 没中
    lines.push(`**${prize.label}**`);
    lines.push('');
    lines.push(prize.text);
    return { ok: true, text: lines.join('\n'), prize, imagePath: null };
  },
};