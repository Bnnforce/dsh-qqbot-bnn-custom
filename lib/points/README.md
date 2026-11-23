# lib/points — 全局积分系统

> 2026-11-17
> 给群友一个跨群共用的积分账户，唯一出口是小店点单。

## 快速开始

```js
import { createPoints } from './lib/points/index.mjs';

const pts = createPoints({
  dataRoot: '<你的数据目录>/人格/积分',
});

await pts.checkin(openid, '昵称');          // 签到 +5
await pts.fortune(openid, score, dateKey);  // 抽签按星级发分
await pts.rps(openid, 'win' | 'tie' | 'lose'); // 猜拳结算
await pts.dice(openid);                     // 骰子 +1
await pts.pay(openid, 14, '买三明治');       // 扣分
await pts.balance(openid);                  // 查余额
```

## 架构

```
config.mjs       参数（21 项，全部可配）
store.mjs        存档（原子写 + 锁 + ledger）
earn.mjs         产出（签到/抽签/猜拳/骰子 + 防刷）
spend.mjs        消费（扣分/退款/事务）
leaderboard.mjs  本群排行
index.mjs        门面
```

## 经济模型

| 来源 | 奖励 | 日上限 |
|---|---|---|
| 签到 | +5 | 5 |
| 抽签 | +0~5（按 score） | 5 |
| 猜拳 | 赢+2 平0 输−1 | 5 次 |
| 骰子 | +1 | 5 次 |
| **全勤日产出** | **14.29** | |
| **常见（只签到+抽签）** | **7.63** | |

### 定价（三档）

| 档 | 价格 | 例子 |
|---|---|---|
| 基础 | 8 | 坚果、海苔、饼干、水果 |
| 常规 | 14 | 茶、牛奶、咖啡、面包、饭团 |
| 进阶 | 25 | 三明治、汤、面、甜品 |
| 特供 | 50/100 | 每天 1 件，限量 1 份 |

**平衡验算**：
- 常见 7.63 买基础 8 → 净 −0.37（刚好花完）
- 全勤 14.29 买常规 14 → 净 +0.29（平衡）

## 防刷设计

### ① 按日期判重（签到/抽签）

```js
// 存档里记
{ checkin: { lastDate: '2026-11-17' } }
// 领取时比对
if (lastDate === today) return { ok: false, reason: 'ALREADY' };
```

### ② 三重限制（玩法）

```js
perGameDailyCap: 5,        // 每个玩法每天最多 5 次有分
playCooldownMs: 60_000,    // 同玩法 60 秒冷却
```

**核心原则：限制的是「得分」，不是「玩」。**
超限后照样能玩，只是提示"今天的分拿满了"。

### ③ 猜拳不扣到负

```js
if (delta < 0 && !cfg.rpsAllowNegative) {
  delta = -Math.min(Math.abs(delta), Math.max(0, balance));
}
```

## 事务与锁

⚠️ **重要**：积分锁（`openid`）和小店锁（`gid`）**永不嵌套**。

调用方必须按这个顺序：

```js
// ① 先扣分（锁 openid）
const payRes = await pts.pay(openid, price);
if (!payRes.ok) return '钱不够';

// ② 再扣库存（锁 gid）
const r = await shop.order(gid, user, item, 1);

// ③ 库存失败 → 退款
if (!r.ok) await pts.refund(openid, payRes.paid);
```

**为什么**：嵌套会死锁（用户1 锁 gid 等 openid，用户2 锁 openid 等 gid）。

`spend.mjs` 提供了 `payThenRun()` 封装这套逻辑。

## 存档格式

```json
// <dataRoot>/<openid>.json
{
  "version": 1,
  "openid": "8648A8EF...",
  "balance": 42,
  "checkin": { "lastDate": "2026-11-17", "totalDays": 23 },
  "fortune": { "lastDateKey": "2026-11-17", "lastScore": 8 },
  "dailyPlay": { "date": "2026-11-17", "used": 3, "byGame": { "rps": 2 } },
  "stats": { "totalEarned": 580, "totalSpent": 538 },
  "ledger": [ { "at": "...", "type": "checkin", "delta": 5, "balance": 47 } ]
}
```

**ledger 保留 100 条**，可用于审计和重建。

**重建**：
```js
const rb = store.rebuildFromLedger(profile);
// { balance, totalEarned, totalSpent }
```

## 隐私

| 红线 | 实现 |
|---|---|
| 余额只对自己可见 | 卡片天然独立 |
| 排行榜只本群 | `topOfGroup(members)` 只筛传入的成员 |
| 不存跨群信息 | 存档只有 openid + 数字，**没有 groupId** |
| 可删除 | `pts.clear(openid)` |

## 配置项（全部）

```js
{
  enabled: true,
  timezone: 'Asia/Shanghai',

  // 获取
  checkinPoints: 5,
  fortunePoints: [0,0,0,1,1,2,3,3,4,5,5],  // index=score
  rpsWinPoints: 2,
  rpsTiePoints: 0,
  rpsLosePoints: -1,
  rpsAllowNegative: false,
  dicePoints: 1,

  // 限次
  perGameDailyCap: 5,
  playCooldownMs: 60_000,

  // 消费
  shopPricing: { basic: 8, normal: 14, advanced: 25 },
  specialOfferEnabled: true,
  specialOfferPrices: [50, 100],
  specialOfferCount: 1,

  // 上限
  maxLedger: 100,
  leaderboardSize: 5,
  leaderboardEnabled: true,

  // 隐私
  balancePrivate: true,

  stateVersion: 1,
}
```

## 错误处理

所有 API **永不抛**（除配置错误），失败返回 `{ ok: false, reason }`。

| reason | 含义 |
|---|---|
| `ALREADY` | 今天已经做过（签到/抽签） |
| `GAME_CAP` | 这个玩法今天的分拿满了 |
| `COOLDOWN` | 冷却中 |
| `NO_MONEY` | 余额不足 |

## 测试

```bash
node Bot/维护/04-测试/mock-points-core.mjs   # 核心 37 项
node Bot/维护/04-测试/mock-points-cards.mjs  # 卡片 16 项
```

## 相关文档

- `Bot/维护/全局积分系统-最终定稿-20261117.md` — 设计定稿
- `Bot/维护/积分方案-审查报告-20261117.md` — 审查（含死锁分析）
- `Bot/维护/积分系统-交付报告-20261117.md` — 交付报告
