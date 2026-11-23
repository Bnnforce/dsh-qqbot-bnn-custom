# wake-lottery — 唤醒抽奖模块（R5.6）

> 她「刚睡醒」时抽一次奖：自己抽给自己看（A），或留张卡片让群友抽（B）。

## 这个模块是什么

把群聊状态变成一次**有仪式感的小事件**：

```
群里安静 20 分钟以上 → 心跳 cold=true
        ↓
调度器每 10 分钟检查一次
        ↓
    ┌───┴───┐
    A 自抽    B 邀请
    ↓         ↓
她抽完说出来   留卡片给群友点
```

## 快速开始

```bash
# 1. 开配置（默认关闭）
echo '{"enabled": true}' > {EXT_DATA}/wake-lottery/config.json

# 2. 重启 DSH（hook 变更需要重启）

# 3. 群里试
/抽              # 参与抽奖（需她已留下邀请）
/抽奖图鉴         # 看收集进度
```

## 九种奖项

| 奖项 | 稀有度 | 权重 | 依赖 |
|---|---|---:|---|
| 一句话 | 普通 | 28 | 人格/每日金句.txt（缺失用内置句）|
| 一张图 | 普通 | 20 | 美图库/ |
| 积分 | 普通 | 14 | 积分系统 |
| 表情包 | 普通 | 8 | 表情包/lib/library/ |
| 一段语音 | 少见 | 14 | 语音配置（可选）|
| 一首歌 | 少见 | 10 | 曲库（可选）|
| 专属称呼 | 稀少 | 3 | 状态文件 |
| 加倍券 | 稀少 | 2 | 状态文件 |
| 隐藏款 | 极稀 | 1 | 秘密文案（内置兜底）|

**实测调优（2026-11-22）**：
- `self` 模式：触发 2 次 → 抽签 2 次 = **100% 转化**
- `invite` 模式：触发 5 次 → 抽签 0 次 = **0% 转化**

冷场群里没人会点卡片（群本来就安静），所以 `selfDrawRatio` 从 0.5 提到 **0.9**。

**核心机制**：
- **永不空奖**（最低一句话）
- **连 5 次普通 → 第 6 次保底稀有**（pityCounter）
- **先问可用池再抽**（不是抽到再降级）

## 配置

文件：`{EXT_DATA}/wake-lottery/config.json`

| 字段 | 默认 | 说明 |
|---|---:|---|
| `enabled` | `false` | 总开关。**默认关，灰度开启** |
| `timezone` | `Asia/Shanghai` | 时区口径 |
| `sleepWindow` | `{start:2,end:6}` | 装死窗，绝不抽 |
| `coldMinMs` | `1200000` | cold 至少持续多久（20 分钟）|
| `perGroupCooldownMs` | `7200000` | 同群间隔（2 小时）|
| `perGroupDailyCap` | `7` | 每群每天上限 |
| `perUserDailyCap` | `3` | 每人每天上限 |
| `globalHourlyCap` | `5` | 全局每小时上限（跨群护栏）|
| `deadGroupMs` | `604800000` | 死群阈值（7 天）|
| `prizeTimeoutMs` | `8000` | 单出口超时 |
| `selfDrawRatio` | **`0.9`** | A 模式占比（1-该值=B）。2026-11-22 从 0.5 调到 0.9：实测 invite 转化率 0% |
| `pityThreshold` | `5` | 保底阈值 |
| `inviteExpireMs` | `7200000` | 邀请有效期 |
| `baseWeights` | 见上表 | 九种奖项权重（和为 100）|
| `minWeight` | `1` | 归一化后最低权重 |
| `dimensionTuning` | `true` | 八维情绪调权 |
| `atlasEnabled` | `true` | 图鉴 |
| `maxMultiplierCoupons` | `3` | 加倍券上限 |
| `outputMaxChars` | `60` | 输出字数上限 |
| `salt` | `wakelottery` | openid 哈希盐 |

**环境变量覆盖**（测试隔离用）：
`BNN_WAKELOTTERY_ENABLED` / `_DIMS` / `_SELF_RATIO` / `_DAILY_CAP` / `_COOLDOWN_MS` / `_COLD_MS` / `_ATLAS` / `_ROOT`

## 目录结构

```
lib/wake-lottery/
├── config.mjs     配置 + 类型守卫 + 环境变量
├── core.mjs       判定 / 权重 / 保底 / A-B（纯函数，零 IO）
├── store.mjs      状态（原子写 / 自愈 / 哈希 / 全局计数）
├── atlas.mjs      图鉴
├── index.mjs      编排层（唯一对外开放）
├── narrate.mjs    文案（wake prompt / 卡片正文）
└── prizes/        9 个出口 + registry
```

## 八维联动

权重会随她的情绪调整（`dimensionTuning: true` 时）：

| 情绪 | 效果 |
|---|---|
| 精力低 | 语音/歌 ↓，一句话 ↑（累了）|
| 联系感高 | 一句话 ↑（想说话）|
| 心情低 | 图片/歌 ↑，隐藏款 ↓（安静陪伴）|
| 亲近度高 | 语音 ↑（更私密）|

**纪律**：不报数值、只影响选择、用户感知不到公式。

## 开源移植

本模块分三层：
- **通用层**（core/store/atlas/registry + quote/points）—— 零私有依赖
- **适配层**（image/voice/song/nickname/multiplier/secret）—— 需配置目录或文案
- **私有层**（语音模型、群内梗）—— 不上架

**移植验证**：
```bash
cp -r lib/wake-lottery /tmp/portable-test/
# 只提供 config，不改源码能跑 = 合格
```

## 测试

```bash
cd {WORKSPACE_ROOT}/Bot
node 维护/04-测试/mock-wakelottery-core.mjs         # 75 条
node 维护/04-测试/mock-wakelottery-store.mjs        # 60 条
node 维护/04-测试/mock-wakelottery-prizes.mjs       # 54 条
node 维护/04-测试/mock-wakelottery-atlas.mjs        # 39 条
node 维护/04-测试/mock-wakelottery-integration.mjs  # 49 条
```

合计 **277 条断言**。

## 红线（改代码前必读）

| # | 红线 | 原因 |
|---|---|---|
| 1 | **只读 R4 状态** | heartbeat / mood-axes 绝不写 |
| 2 | **openid 只存哈希** | 隐私（开源要求）|
| 3 | **失败绝不抛** | 官方契约 |
| 4 | **不写记忆库** | 不污染对话上下文 |
| 5 | **B 模式不调 appendWake** | 会多发一条消息（全项目约定）|
| 6 | **先问可用池再抽** | 不要退化回「抽到再降级」|

## 相关文档

- 方案：`Bot/维护/02-版本方案/R5.6-唤醒抽奖/R5.6-唤醒抽奖-最终方案.md`
- 契约：`Bot/维护/02-版本方案/R5.6-唤醒抽奖/接口契约.md`
