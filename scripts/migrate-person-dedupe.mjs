#!/usr/bin/env node
/**
 * migrate-person-dedupe.mjs — 人物卡跨群去重迁移（R8 S2，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 隐私红线（本脚本最高优先级）
 *
 *   人物卡里有两类信息，处理方式完全不同：
 *
 *   ① **客观事实**（可跨群）
 *      · openid、生日、昵称/别名
 *      · 这类可以合并到主卡
 *
 *   ② **群内观察**（绝不跨群）
 *      · 「会直接调侃 bot」「喜欢深夜聊天」这类从某个群的行为推出来的
 *      · A 群的观察绝不能进 B 群的卡
 *
 *   **本脚本的保守策略**：
 *     · 默认**只生成跨群索引**，不合并任何正文内容
 *     · 只有显式 --merge-facts 才合并「生日/别名」这类纯客观字段
 *     · 任何情况下都不合并 History 段（那是群内观察的聚集地）
 *
 *   ⇒ 宁可不合并，也不能跨群泄露。
 *
 * ── 默认 dry-run ──────────────────────────────────────────────────────────
 *
 *   node scripts/migrate-person-dedupe.mjs            # 干跑（只报告）
 *   node scripts/migrate-person-dedupe.mjs --apply    # 执行（自动备份）
 *   node scripts/migrate-person-dedupe.mjs --apply --merge-facts  # 额外合并客观事实
 *
 * ── 执行内容（--apply）────────────────────────────────────────────────────
 *
 *   1. 备份整个 group-memory 到 .backup/<timestamp>/
 *   2. 在 memory 根写 people-index.json（openid → 各群卡路径的索引）
 *   3. 可选：把主卡缺的「生日/别名」补进去（只加不删）
 *   4. **不删除任何原卡**（保守：让调用方可自行决定）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scanCards, findDuplicates } from './analyze-person-duplicates.mjs';

/** 记忆根（可用 BNN_MEMORY_ROOT 覆盖）。 */
const MEMORY_ROOT = String(process.env.BNN_MEMORY_ROOT || '').trim()
  || '/sdcard/DSH/Bot/dshqqbot/.qqbot-extensions/data/group-memory';

/** 备份根。 */
const BACKUP_ROOT = join(MEMORY_ROOT, '.backup');

/** 索引文件名。 */
const INDEX_FILE = 'people-index.json';

/**
 * 从卡片正文里抽取「客观事实」行（生日 / 别名）。
 *
 * ★ 只抽这两类，因为它们是纯客观的、跨群安全的。
 *   「备注 / 说明 / 会调侃 bot」这类一律不碰 —— 那是群内观察。
 *
 * @param {string} text
 * @returns {{birthday:string, aliases:string[]}}
 */
export function extractObjectiveFacts(text) {
  const t = String(text ?? '');
  const out = { birthday: '', aliases: [] };

  // 生日：`- 生日：每年 7 月 28 日。` 或 `- 生日：07-28`
  const bd = t.match(/-\s*生日[：:]\s*([^\n。]+)/);
  if (bd) out.birthday = bd[1].trim();

  // 别名：`群成员：X（别名「Y」）` 或 `- 别名：Y`
  const aliasPatterns = [
    /别名[「"]([^」"]+)[」"]/g,
    /-\s*别名[：:]\s*([^\n。]+)/g,
  ];
  for (const re of aliasPatterns) {
    let m;
    while ((m = re.exec(t)) !== null) {
      const a = String(m[1] ?? '').trim();
      if (a && !out.aliases.includes(a)) out.aliases.push(a);
    }
  }
  return out;
}

/**
 * 生成跨群索引（不改任何原卡）。
 *
 * @param {Array<object>} duplicates
 * @param {string} [root]
 * @returns {object} 索引对象
 */
export function buildIndex(duplicates, root = MEMORY_ROOT) {
  const idx = { _v: 1, generatedAt: new Date().toISOString(), people: {} };
  for (const d of duplicates) {
    idx.people[d.openid] = {
      names: d.names,
      primary: { gid: d.primary.gid, name: d.primary.name },
      cards: d.groups.map((g) => ({
        gid: g.gid,
        name: g.name,
        groupName: g.groupName,
        // 存相对路径，换机器也能用
        path: relative(root, join(root, 'groups', g.gid, 'entities', 'people', `${g.name}.md`)),
      })),
    };
  }
  return idx;
}

/**
 * 执行迁移。
 *
 * @param {{apply?:boolean, mergeFacts?:boolean, root?:string}} opts
 * @returns {object} 结果
 */
export function migrate(opts = {}) {
  const root = String(opts.root || MEMORY_ROOT);
  const apply = opts.apply === true;
  const mergeFacts = opts.mergeFacts === true;

  const cards = scanCards(root);
  const r = findDuplicates(cards);

  const result = {
    apply,
    mergeFacts,
    totalCards: r.total,
    uniqueOpenids: r.unique,
    duplicateCount: r.duplicates.length,
    redundantCards: r.duplicates.reduce((s, d) => s + (d.count - 1), 0),
    backupDir: '',
    indexWritten: false,
    factsMerged: 0,
    actions: [],
  };

  if (!r.duplicates.length) {
    result.actions.push({ type: 'noop', reason: '没有跨群重复' });
    return result;
  }

  // 计划动作（dry-run 也能看到）
  for (const d of r.duplicates) {
    const primary = d.groups.find((g) => g.gid === d.primary.gid) || d.groups[0];
    const others = d.groups.filter((g) => !(g.gid === primary.gid && g.name === primary.name));
    result.actions.push({
      type: 'index',
      openid: d.openid,
      names: d.names,
      primary: { gid: primary.gid, name: primary.name },
      others: others.map((g) => ({ gid: g.gid, name: g.name })),
    });

    if (mergeFacts) {
      // 从各卡抽客观事实，看主卡缺什么
      const primaryCard = cards.find((c) => c.openid === d.openid && c.gid === primary.gid && c.name === primary.name);
      if (!primaryCard) continue;
      const have = extractObjectiveFacts(primaryCard.text);
      for (const o of others) {
        const otherCard = cards.find((c) => c.openid === d.openid && c.gid === o.gid && c.name === o.name);
        if (!otherCard) continue;
        const other = extractObjectiveFacts(otherCard.text);
        // 主卡没有生日、其他卡有 → 值得补
        if (!have.birthday && other.birthday) {
          result.actions.push({
            type: 'merge-fact',
            openid: d.openid,
            field: 'birthday',
            value: other.birthday,
            from: o.gid.slice(0, 8),
            to: primary.gid.slice(0, 8),
          });
        }
        // 主卡没有的别名 → 值得补
        for (const a of other.aliases) {
          if (!have.aliases.includes(a)) {
            result.actions.push({
              type: 'merge-fact',
              openid: d.openid,
              field: 'alias',
              value: a,
              from: o.gid.slice(0, 8),
              to: primary.gid.slice(0, 8),
            });
          }
        }
      }
    }
  }

  if (!apply) {
    result.actions.push({ type: 'dry-run', reason: '未加 --apply，未做任何修改' });
    return result;
  }

  // ── 真正执行 ──
  // ① 备份
  //   ★ 2026-11-26 修（真 bug）：原来用模块级 BACKUP_ROOT，
  //     测试传 root 时备份仍写到**真实数据目录**，污染了线上数据。
  //     现在备份根必须跟随 root。
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = join(root, '.backup');
  const backupDir = join(backupRoot, ts);
  try {
    mkdirSync(backupDir, { recursive: true });
    cpSync(join(root, 'groups'), join(backupDir, 'groups'), { recursive: true });
    writeFileSync(join(backupDir, 'MANIFEST.json'), JSON.stringify({
      at: new Date().toISOString(),
      reason: 'person-dedupe-migration',
      totalCards: r.total,
      duplicateCount: r.duplicates.length,
      mergeFacts,
    }, null, 2), 'utf8');
    result.backupDir = backupDir;
  } catch (e) {
    result.actions.push({ type: 'error', reason: '备份失败，已中止', err: String(e?.message ?? e) });
    return result;
  }

  // ② 写索引
  try {
    const idx = buildIndex(r.duplicates, root);
    writeFileSync(join(root, INDEX_FILE), JSON.stringify(idx, null, 2), 'utf8');
    result.indexWritten = true;
  } catch (e) {
    result.actions.push({ type: 'error', reason: '索引写入失败', err: String(e?.message ?? e) });
  }

  // ③ 可选：补客观事实（只加不删，且不碰 History）
  if (mergeFacts) {
    for (const a of result.actions.filter((x) => x.type === 'merge-fact')) {
      try {
        const cardsNow = scanCards(root);
        const primary = cardsNow.find((c) => c.openid === a.openid && c.gid.startsWith(a.to) === false && c.gid.slice(0, 8) === a.to);
        if (!primary) continue;
        let text = readFileSync(primary.path, 'utf8');
        const line = a.field === 'birthday' ? `- 生日：${a.value}。` : `- 别名：${a.value}。`;
        if (text.includes(line)) continue;
        // 插到 Current 段末尾（History 之前）
        const histIdx = text.indexOf('## History');
        if (histIdx < 0) continue;
        text = text.slice(0, histIdx).trimEnd() + '\n' + line + '\n\n' + text.slice(histIdx);
        writeFileSync(primary.path, text, 'utf8');
        result.factsMerged += 1;
      } catch { /* 单条失败不影响其他 */ }
    }
  }

  return result;
}

/** 主入口。 */
function main() {
  const apply = process.argv.includes('--apply');
  const mergeFacts = process.argv.includes('--merge-facts');

  console.log('════ 人物卡跨群去重迁移 ════');
  console.log('');
  console.log(`  模式：${apply ? '⚠️ APPLY（会改数据）' : '✅ DRY-RUN（只报告）'}`);
  console.log(`  合并客观事实：${mergeFacts ? '是' : '否（只建索引）'}`);
  console.log('');

  const r = migrate({ apply, mergeFacts });

  console.log(`  卡片总数：${r.totalCards}`);
  console.log(`  唯一 openid：${r.uniqueOpenids}`);
  console.log(`  重复人数：${r.duplicateCount}`);
  console.log(`  冗余卡片：${r.redundantCards} 张`);
  console.log('');

  if (r.backupDir) console.log(`  备份：${r.backupDir}`);
  if (r.indexWritten) console.log(`  索引：${INDEX_FILE} 已写入`);
  if (r.factsMerged) console.log(`  补全事实：${r.factsMerged} 条`);
  console.log('');

  const idxActions = r.actions.filter((a) => a.type === 'index');
  if (idxActions.length) {
    console.log('  ── 索引计划 ──');
    for (const a of idxActions) {
      console.log(`    ${a.openid.slice(0, 8)}…  ${a.names.join('/')}  主卡=${a.primary.gid.slice(0, 8)}  其他群=${a.others.length}`);
    }
    console.log('');
  }

  const facts = r.actions.filter((a) => a.type === 'merge-fact');
  if (facts.length) {
    console.log('  ── 客观事实补全计划 ──');
    for (const a of facts) {
      console.log(`    ${a.openid.slice(0, 8)}…  ${a.field}=${a.value}  (${a.from} → ${a.to})`);
    }
    console.log('');
  }

  const errors = r.actions.filter((a) => a.type === 'error');
  if (errors.length) {
    console.log('  ❌ 错误：');
    for (const e of errors) console.log(`    ${e.reason}: ${e.err}`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log('  ⓘ 这是干跑，什么都没改。');
    console.log('    确认无误后加 --apply 执行。');
  } else {
    console.log('  ✅ 已执行。回滚：node scripts/memory-rollback.mjs');
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate-person-dedupe.mjs')) {
  main();
}
