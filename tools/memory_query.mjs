/**
 * memory_query — 统一记忆查询工具（R8，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个工具：
 *
 *   R7 新增了 4 类记忆（群史/关系/成长/生活流），但**一个工具都查不到** ——
 *   数据在写，模型读不到，等于白写。
 *
 *   这个工具把 6 套存储统一成一个查询入口：
 *     · 模型可以主动查「这个群经历过什么」「我跟谁熟」
 *     · 也可以一次拿某人的全部记忆
 *
 *   ⚠️ 纯只读：绝不写任何数据（零风险）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readPerson, readGroup, readChronicle, readRelations, readEvolution, readLifeStream, readSlang, overview } from '../lib/memory/read.mjs';
import { associate } from '../lib/memory/associate.mjs';
import { commandPeer } from '../lib/pure/card-kit.mjs';

/** 脱敏：任何输出不得含 32 位 hex openid。 */
function scrub(s) {
  return String(s ?? '').replace(/[0-9A-Fa-f]{32}/g, '【某人】');
}

/**
 * 群 id 短显示。
 *
 * ★ 2026-11-26：原来直接把完整 gid 返回给模型。
 *   群 id 虽不是个人隐私，但 32 位 hex 出现在输出里会被隐私检查判为泄露，
 *   也浪费 token。统一显示前 8 位即可定位。
 */
function shortGid(g) {
  const t = String(g ?? '').replace(/^group_/, '');
  return t.length > 8 ? t.slice(0, 8) + '…' : t;
}

/** 截断。 */
function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

export default {
  name: 'memory_query',
  description: [
    '查询机器人的长期记忆。',
    'scope=group 看这个群经历过什么；',
    'scope=person 看某个群友的全部记忆（需 openid）；',
    'scope=relations 看群里谁跟谁熟；',
    'scope=growth 看她这段时间的变化；',
    'scope=life 看她自己的日常；',
    'scope=slang 看群黑话；',
    'scope=overview 看记忆总量。',
  ].join(''),

  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['group', 'person', 'relations', 'growth', 'life', 'slang', 'overview', 'associate'],
        description: '查什么',
      },
      openid: { type: 'string', description: 'scope=person 时必填：群友 openid' },
      query: { type: 'string', description: 'scope=associate 时必填：联想的关键词或一句话' },
      gid: { type: 'string', description: '群 id；不填则用当前群' },
      limit: { type: 'number', description: '最多返回几条，默认 10' },
    },
    required: ['scope'],
  },

  async run(args, env) {
    const scope = String(args?.scope ?? '').trim();
    const limit = Number(args?.limit) > 0 ? Math.min(50, Number(args.limit)) : 10;

    // 群 id：优先参数，其次从 env 推断
    const gidFromEnv = (() => {
      try {
        const { gid } = commandPeer(env ?? {});
        return gid;
      } catch { return ''; }
    })();
    const gid = String(args?.gid ?? '').trim() || gidFromEnv;

    try {
      switch (scope) {
        case 'group': {
          if (!gid) return { ok: false, error: '需要群 id' };
          const g = readGroup(gid);
          return {
            ok: true,
            gid: shortGid(gid),
            chronicle: g.chronicle.slice(-limit).map((e) => ({
              date: e.date,
              参与人数: Array.isArray(e.participants) ? e.participants.length : 0,
              消息数: e.msgCount,
              得分: e.score,
            })),
            chronicleText: scrub(clip(g.chronicleText, 400)),
            relationCount: Object.keys(g.relations).length,
            slang: g.slang.slice(0, limit),
            birthdays: g.birthdays,
            lifeRecent: g.lifeStream.slice(-3).map((l) => ({ at: l.at, activity: l.activity, detail: scrub(clip(l.detail, 60)) })),
          };
        }

        case 'person': {
          const oid = String(args?.openid ?? '').trim();
          if (!oid) return { ok: false, error: 'scope=person 需要 openid' };
          const p = readPerson(oid, gid ? { gid } : {});
            // ★ R8 S5：附上「关系强度排行」和「联想」，让一次查询拿到完整画像
            const rels = p.relations
              .slice()
              .sort((a, b) => (Number(b.interactions) || 0) - (Number(a.interactions) || 0))
              .slice(0, limit)
              .map((r) => ({
                key: scrub(r.key),
                interactions: Number(r.interactions) || 0,
                closeness: r.closeness ?? null,
                tension: r.tension ?? null,
              }));

            // 从人物卡里抽名字，做三跳联想（复用 associate，不重写）
            let related = [];
            try {
              const name = (p.cards[0]?.text ?? '').match(/^#\s*群成员[—-](.+)$/m)?.[1]?.trim() ?? '';
              if (name && gid) {
                const a = associate(gid, name, { maxHops: 2, perHopLimit: 2 });
                related = (a.hits ?? []).slice(0, limit).map((h) => ({
                  kind: h.kind, id: scrub(String(h.id)), hop: h.hop, text: scrub(clip(h.text, 80)),
                }));
              }
            } catch { /* 联想失败不影响主查询 */ }

            return {
              ok: true,
              openid: scrub(oid),
              cards: p.cards.map((c) => ({ gid: shortGid(c.gid), text: scrub(clip(c.text, 500)) })),
              relations: rels,
              mentionedIn: p.mentionedIn.slice(-limit).map((m) => ({ gid: shortGid(m.gid), date: m.date, participants: m.participants, score: m.score })),
              birthdays: p.birthdays.map((b) => ({ gid: shortGid(b.gid), list: b.list })),
              related,
            };
        }

        case 'relations': {
          if (!gid) return { ok: false, error: '需要群 id' };
          const rels = readRelations(gid);
          const rows = Object.entries(rels)
            .map(([k, v]) => ({
              pair: scrub(k),
              interactions: Number(v?.interactions) || 0,
              closeness: v?.closeness ?? null,
              tension: v?.tension ?? null,
              close: v?.close === true,
            }))
            .sort((a, b) => b.interactions - a.interactions)
            .slice(0, limit);
          return { ok: true, gid: shortGid(gid), total: Object.keys(rels).length, top: rows };
        }

        case 'growth': {
          const list = readEvolution({ limit });
          const last = list[list.length - 1] ?? null;
          return {
            ok: true,
            snapshots: list.length,
            latest: last ? {
              period: last.period,
              style: last.style,
              mood: last.mood,
              social: last.social,
            } : null,
          };
        }

        case 'life': {
          if (!gid) return { ok: false, error: '需要群 id' };
          const logs = readLifeStream(gid, { limit });
          return {
            ok: true,
            gid: shortGid(gid),
            count: logs.length,
            recent: logs.map((l) => ({ at: l.at, hour: l.hour, activity: l.activity, detail: scrub(clip(l.detail, 60)) })),
          };
        }

        case 'slang': {
          if (!gid) return { ok: false, error: '需要群 id' };
          const list = readSlang(gid);
          return { ok: true, gid: shortGid(gid), count: list.length, list: list.slice(0, limit) };
        }

        case 'associate': {
          const q = String(args?.query ?? '').trim();
          if (!q) return { ok: false, error: 'scope=associate 需要 query' };
          if (!gid) return { ok: false, error: '需要群 id' };
          // ★ 复用 lib/memory/associate.mjs 的三跳联想，不重写逻辑
          const a = associate(gid, q, { maxHops: 3, perHopLimit: 3 });
          return {
            ok: true,
            gid: shortGid(gid),
            keywords: (a.keywords ?? []).map((k) => scrub(String(k))),
            hits: (a.hits ?? []).slice(0, limit).map((h) => ({
              kind: h.kind,
              id: scrub(String(h.id)),
              hop: h.hop,
              text: scrub(clip(h.text, 100)),
            })),
            summary: scrub(clip(a.summary ?? '', 400)),
          };
        }

        case 'overview': {
          const o = overview();
          return { ok: true, ...o };
        }

        default:
          return { ok: false, error: `未知 scope: ${scope}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
