/**
 * group_history — 读「本群最近几天」的聊天记录（只读，群友可用）
 *
 * 背景（2026-11-05）：
 *   群里有人问「这个群昨天在干嘛」，她答「我这记性只剩点模糊的影子了」。
 *   查证发现：**昨天的消息其实完整躺在磁盘上**（`{dataRoot}/.qqbot/msg-history/group_<gid>/<date>.jsonl`），
 *   但**没有任何工具能读它** —— 她甚至误以为存在一个 `group_msg_search`（那是 QQBot 内置、
 *   且被 guard 列为仅主人的名字，实际并不在扩展工具面里）。
 *   本工具就是补上这个只读缺口。
 *
 * 红线（不能碰的东西，改之前先读这段）：
 *   1. **只读**：绝不写、绝不删、绝不改任何历史文件。
 *   2. **只能读本群**：没有「查别的群」参数；跨群查询一律拒绝（按群隔离是硬规则）。
 *   3. **只能看最近 3 天**（`MAX_DAYS`）：防止群友让你把整个群史翻一遍 → token 爆炸 + 隐私翻旧账。
 *   4. **不返回原文全量**：每条消息截断 `MAX_CHARS`，总条数上限 `MAX_MSGS`，超出只给"还有 N 条"提示。
 *      这是给「回忆昨天聊了啥」用的，不是给全文检索用的。
 *   5. 群友与主人**同样受限**（这不是权限工具，是能力工具）；但主人可以多看一天（见 days 上限差异）。
 *
 * 数据格式（实测 2026-11-04）：
 *   {"id","s","n","t","k","x","me"}
 *   · s   = 发送者 openid；`self` = 机器人自己
 *   · n   = 昵称
 *   · t   = 毫秒时间戳
 *   · k   = 类型（text / image / ...）
 *   · x   = 正文（图片等非文本消息通常为空）
 *   · me  = true 表示这条是机器人自己发的
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isOwnerEnv } from './lib/owner.mjs';

/** 最多往回看几天（含今天）。群友只能看 2 天（今天+昨天），主人 3 天。 */
const MAX_DAYS_OWNER = 3;
const MAX_DAYS_GUEST = 2;
/** 单次最多返回多少条（防止上下文爆炸）。 */
const MAX_MSGS = 120;
/** 每条正文最多多少字。 */
const MAX_CHARS = 120;
/** 单日文件上限（超过就不读了，防止超大文件卡住）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function dataRootOf(env) {
  return String(env?.dataRoot || env?.caps?.dataRoot || '').trim();
}
/** 当前群 gid —— **只认 group scope**，私聊/其它一律返回空（本工具只管群历史）。 */
function currentGid(env) {
  const scope = String(env?.peer?.scope ?? env?.peerScope ?? '');
  const id = String(env?.peer?.peerId ?? env?.peerId ?? env?.groupId ?? '').trim();
  return scope === 'group' && id ? id : '';
}
/** 群历史目录。 */
function historyDir(root, gid) {
  return join(root, '.qqbot', 'msg-history', `group_${gid}`);
}
/** 本地日期 key（Asia/Shanghai 口径，与 QQBot 落盘一致）。 */
function dayKey(ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(ms)).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
function hhmm(ms) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    return `${p.hour}:${p.minute}`;
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
/** 清理消息正文：去 @ 标记、折叠空白、截断。 */
function cleanText(raw) {
  return String(raw ?? '')
    .replace(/<@[A-Za-z0-9]+>/g, '')   // @ 标记（openid）
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}
/** 读某一天的 JSONL。任何异常 → 空数组（静默降级，绝不抛）。 */
function readDay(dir, date) {
  const file = join(dir, `${date}.jsonl`);
  try {
    if (!existsSync(file)) return [];
    if (statSync(file).size > MAX_FILE_BYTES) return [];
    const raw = readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 单行坏不影响其它行 */ }
    }
    return out;
  } catch { return []; }
}

export default {
  name: 'group_history',
  expose: 'qq',
  description:
    '读「本群最近几天」的聊天记录（只读）。被问「昨天/前天群里聊了什么、在干嘛」时用它，' +
    '读不到再说记不清。只能查本群，不能查别的群；只覆盖最近 2~3 天，不会给你整个群史。',
  inputSchema: {
    days: { type: 'integer', description: '可选：往回看几天，1=只看今天，2=今天+昨天（默认 2）' },
    query: { type: 'string', description: '可选：只看包含这个词的消息（不填=按时间列出）' },
    who: { type: 'string', description: '可选：只看某个人的发言（填昵称片段即可，如"昵称片段"）' },
    limit: { type: 'integer', description: `可选：最多返回几条，默认 60，上限 ${MAX_MSGS}` },
    includeSelf: { type: 'boolean', description: '可选：是否包含机器人自己发的消息，默认 true' },
  },
  async run(args = {}, env = {}) {
    try {
      const root = dataRootOf(env);
      if (!root) return { ok: false, msg: '拿不到数据根（env.dataRoot 为空）' };

      const gid = currentGid(env);
      // ★ 硬限制：只认群上下文。私聊/Web 里没群可查 —— 直接说明，不要瞎猜群号。
      if (!gid) {
        return { ok: false, msg: '这个工具只在 QQ 群里能用（我这里是私聊/其它上下文，看不到群聊天记录）。' };
      }

      const dir = historyDir(root, gid);
      if (!existsSync(dir)) {
        return { ok: true, msg: '本群还没有聊天记录存档，我不知道更早的事。', data: { gid, messages: [] } };
      }

      const owner = isOwnerEnv(env);
      const maxDays = owner ? MAX_DAYS_OWNER : MAX_DAYS_GUEST;
      const wantDays = Math.max(1, Math.min(maxDays, Math.floor(Number(args?.days) > 0 ? Number(args.days) : 2)));
      const limit = Math.max(1, Math.min(MAX_MSGS, Math.floor(Number(args?.limit) > 0 ? Number(args.limit) : 60)));
      const query = String(args?.query ?? '').trim().toLowerCase();
      const who = String(args?.who ?? '').trim().toLowerCase();
      const includeSelf = args?.includeSelf === false ? false : true;

      // 可用日期：从今天往前数。只看**存在文件**的天数，避免返回空洞。
      const now = Date.now();
      const candidates = [];
      for (let i = 0; i < wantDays; i += 1) candidates.push(dayKey(now - i * 86400000));
      const available = [];
      for (const d of candidates) {
        try { if (existsSync(join(dir, `${d}.jsonl`))) available.push(d); } catch { /* ignore */ }
      }
      if (!available.length) {
        return { ok: true, msg: `最近 ${wantDays} 天本群没有聊天记录（可能大家都没说话）。`, data: { gid, messages: [] } };
      }

      // 收集（按时间正序）
      const all = [];
      for (const d of available.slice().reverse()) {
        for (const m of readDay(dir, d)) {
          all.push({ ...m, _day: d });
        }
      }
      all.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));

      // 过滤
      let picked = all;
      if (!includeSelf) picked = picked.filter((m) => String(m.s) !== 'self' && m.me !== true);
      if (who) picked = picked.filter((m) => String(m.n ?? '').toLowerCase().includes(who));
      if (query) {
        picked = picked.filter((m) => {
          const text = cleanText(m.x).toLowerCase();
          return text.includes(query) || String(m.n ?? '').toLowerCase().includes(query);
        });
      }

      if (!picked.length) {
        const cond = [who ? `“${args.who}”说的` : '', query ? `含“${args.query}”的` : ''].filter(Boolean).join('且');
        return { ok: true, msg: `最近 ${available.length} 天里没有${cond || ''}消息。`, data: { gid, messages: [] } };
      }

      const total = picked.length;
      // 超出上限时**保留最近的**（越新越有用），并告知省略了多少
      const dropped = Math.max(0, total - limit);
      const shown = dropped ? picked.slice(-limit) : picked;

      const lines = [];
      let lastDay = '';
      for (const m of shown) {
        const t = Number(m.t) || 0;
        if (m._day !== lastDay) {
          lastDay = m._day;
          lines.push(`【${m._day}】`);
        }
        const isSelf = String(m.s) === 'self' || m.me === true;
        const name = isSelf ? '我' : (String(m.n ?? '').trim() || '某人');
        const kind = String(m.k ?? 'text');
        const text = cleanText(m.x);
        let body = text;
        if (!body) {
          // 非文本消息（图片/卡片/语音…）给个可读占位，别返回空行
          if (kind === 'image' || kvIsImage(m)) body = '（发了一张图，没留文字）';
          else if (kind === 'text') body = '（空消息）';
          else body = `（${kind} 消息）`;
        }
        lines.push(`- ${hhmm(t)} ${name}: ${body}`);
      }

      const head = `本群最近 ${available.length} 天记录（${available.join('、')}，共 ${total} 条${dropped ? `，只显示最近 ${shown.length} 条，省略更早 ${dropped} 条` : ''}）：`;
      const foot = [
        '注：这是存档里的原文摘要（每条已截断），图/卡片/语音只看得到占位；',
        '    只覆盖最近几天，更早的记录我也看不到——那部分该说记不清就说记不清。',
      ].join('\n');

      return {
        ok: true,
        msg: `【${'本群聊天存档'}】\n${head}\n${lines.join('\n')}\n${foot}`,
        data: {
          gid,
          days: available,
          total,
          shown: shown.length,
          messages: shown.map((m) => ({
            t: Number(m.t) || 0, time: hhmm(Number(m.t) || 0),
            name: String(m.s) === 'self' || m.me === true ? '我' : String(m.n ?? ''),
            isSelf: String(m.s) === 'self' || m.me === true,
            kind: String(m.k ?? 'text'), text: cleanText(m.x),
          })),
        },
      };
    } catch (e) {
      // 任何异常都静默降级成一句人话，绝不让工具抛错打断回合
      return { ok: false, msg: `读群记录时出错了（${e instanceof Error ? e.message : String(e)}），先按记不清处理吧。` };
    }
  },
};

/** QQBot 有些图片消息把类型塞在别的字段里，这里做个轻量兜底判断。 */
function kvIsImage(m) {
  try {
    const k = String(m?.k ?? '');
    if (k.includes('image')) return true;
    const raw = JSON.stringify(m).toLowerCase();
    return raw.includes('"image"') || raw.includes('.jpg') || raw.includes('.png');
  } catch { return false; }
}
