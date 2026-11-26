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
import { commandPeer } from '../lib/pure/card-kit.mjs';

/** 脱敏：任何输出不得含 32 位 hex openid。 */
function scrub(s) {
  return String(s ?? '').replace(/[0-9A-Fa-f]{32}/g, '【某人】');
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
        enum: ['group', 'person', 'relations', 'growth', 'life', 'slang', 'overview'],
        description: '查什么',
      },
      openid: { type: 'string', description: 'scope=person 时必填：群友 openid' },
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
            gid,
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
          return {
            ok: true,
            openid: scrub(oid),
            cards: p.cards.map((c) => ({ gid: c.gid, text: scrub(clip(c.text, 500)) })),
            relations: p.relations.map((r) => ({
              key: scrub(r.key), interactions: r.interactions, closeness: r.closeness, tension: r.tension,
            })),
            mentionedIn: p.mentionedIn.slice(-limit),
            birthdays: p.birthdays.map((b) => ({ gid: b.gid, list: b.list })),
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
          return { ok: true, gid, total: Object.keys(rels).length, top: rows };
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
            gid,
            count: logs.length,
            recent: logs.map((l) => ({ at: l.at, hour: l.hour, activity: l.activity, detail: scrub(clip(l.detail, 60)) })),
          };
        }

        case 'slang': {
          if (!gid) return { ok: false, error: '需要群 id' };
          const list = readSlang(gid);
          return { ok: true, gid, count: list.length, list: list.slice(0, limit) };
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
