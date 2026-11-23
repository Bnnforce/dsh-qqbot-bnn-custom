/**
 * itinerary-reminder — 恢复个人行程定时器；到点直接发消息，不唤醒 LLM。
 * 一人一文件，按 owner 隔离。发送走 env.caps.api（QQ 官方接口），不经过 AI。
 */
import { dataRootOf, listPeople, loadPerson, savePerson, pushHistory, nextRepeat, localStamp } from '../lib/itinerary.mjs';

const timers = new Map();
const firing = new Set();
const MAX_CHUNK = 20 * 86400000;

async function sendReminder(env, item, late = false) {
  const mention = item.scope === 'group' && item.owner ? `<@${item.owner}> ` : '';
  const text = `${mention}⏰${late ? '（迟到的提醒）' : ''} 提醒：${item.text}` +
    (item.repeat === 'daily' ? '（每天这个点）' : item.repeat === 'weekday' ? '（工作日这个点）' : '');
  const path = item.scope === 'group'
    ? `/v2/groups/${encodeURIComponent(item.target)}/messages`
    : `/v2/users/${encodeURIComponent(item.target)}/messages`;
  const body = item.scope === 'group' && mention
    ? { markdown: { content: text }, msg_type: 2, msg_seq: Math.floor(Date.now() / 1000) % 1000000 }
    : { content: text, msg_type: 0, msg_seq: Math.floor(Date.now() / 1000) % 1000000 };
  try {
    const r = await env.caps.api(path, { method: 'POST', body });
    return r?.ok === true;
  } catch (e) {
    env.logger?.warn?.(`[itinerary] 发送失败 ${String(item.owner).slice(0, 6)}…: ${e?.message ?? e}`);
    return false;
  }
}

async function fire(env, owner, id, fireAt, late = false) {
  const fk = `${owner}:${id}:${fireAt}`;
  if (firing.has(fk)) return;
  firing.add(fk);
  try {
  const person = loadPerson(env.dataRoot, owner);
  const idx = person.pending.findIndex((x) => String(x.id) === String(id) && Number(x.fireAt) === Number(fireAt));
  if (idx < 0) return;
  const item = person.pending[idx];
  const ok = await sendReminder(env, item, late);
  pushHistory(person, {
    id: item.id, owner: item.owner, text: item.text,
    fireAt: item.fireAt, firedAt: Date.now(),
    result: ok ? (late ? 'missed' : 'sent') : 'failed',
  });
  if (item.repeat && item.repeat !== 'once') {
    item.fireAt = nextRepeat(item);
    item.timeText = localStamp(item.fireAt);
    person.pending[idx] = item;
  } else {
    person.pending.splice(idx, 1);
  }
  if (!ok) {
    person.unsent = Array.isArray(person.unsent) ? person.unsent : [];
    person.unsent.push({ text: item.text, at: Date.now() });
    if (person.unsent.length > 20) person.unsent = person.unsent.slice(-20);
  }
  savePerson(env.dataRoot, person);
  if (item.repeat && item.repeat !== 'once') arm(env, item);
  } finally { firing.delete(fk); }
}

function arm(env, item) {
  const key = `${item.owner}:${item.id}:${item.fireAt}`;
  if (timers.has(key)) return;
  const delay = Number(item.fireAt) - Date.now();
  const wait = Math.max(0, Math.min(MAX_CHUNK, delay));
  const timer = setTimeout(() => {
    timers.delete(key);
    if (Number(item.fireAt) - Date.now() > 1000) {
      // 长行程分段：重新读取最新 item 再挂
      arm(env, item);
      return;
    }
    void fire(env, item.owner, item.id, item.fireAt).catch((e) => {
      env.logger?.warn?.(`[itinerary] 定时器异常: ${e?.message ?? e}`);
    });
  }, wait);
  timer.unref?.();
  timers.set(key, timer);
}

async function sweep(env) {
  const people = listPeople(env.dataRoot);
  const now = Date.now();
  for (const person of people) {
    for (const item of [...person.pending]) {
      if (!item?.id || !item?.fireAt) continue;
      if (Number(item.fireAt) < now - 60_000) {
        await fire(env, person.owner, item.id, item.fireAt, true).catch((e) => {
          env.logger?.warn?.(`[itinerary] 迟到补发失败: ${e?.message ?? e}`);
        });
      } else {
        arm(env, item);
      }
    }
  }
}

export async function run(env) {
  const root = dataRootOf(env) || env.dataRoot;
  if (!root) return 'no-data-root';
  await sweep(env);
  // 运行中新添加的行程也要能挂上：每 5 秒扫描一次。
  const scanner = setInterval(() => { void sweep(env).catch((e) => env.logger?.warn?.(`[itinerary] 扫描失败: ${e?.message ?? e}`)); }, 5000);
  scanner.unref?.();
  env.logger?.info?.(`[itinerary] 已恢复 ${timers.size} 个定时器`);
  env.registerDispose?.(() => {
    clearInterval(scanner);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });
  return `ok(timers=${timers.size})`;
}

export function dispose() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
export default { name: 'itinerary-reminder', run, dispose };
