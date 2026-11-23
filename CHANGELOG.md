# Changelog

> ⚠️ **补丁快照说明（2026-11-21 补）**：文中提到的 `维护/补丁快照/` 目录**已于 2026-11-21 按主人要求删除**，
> `repair-qqbot-patches.mjs --fix` 不再能自动恢复 dist 补丁。本文正文保持原貌。


> ⚠️ **归档说明（2026-11-21 补）**：文中提到的 `维护/99-归档/`、`维护/归档/` 等归档路径**已于 2026-11-21 整体删除**，
> 相关文件不可再找回。本文正文保持写作当时的原貌（历史记录，改了会失真）。


本扩展的所有重要变更记录在此。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

## [1.0.58] - 2026-11-23

### Added

- **首次开源上架**：仓库 <https://github.com/Bnnforce/dsh-qqbot-bnn-custom>（MIT）
- `docs/` 三篇文档：`架构说明.md`（消息链路 + 六个扩展点位置）、`扩展点速查.md`（各自导出形态与真实坑）、`排障手册.md`（症状→查哪里 + 日志位置表）
- `THIRD-PARTY-NOTICES.md`：内置组件许可汇总（MIT / Apache-2.0 / **zlib**——`puff` 是 Mark Adler 的 zlib 许可，不是 MIT）
- `scripts/doctor.mjs`：环境自检（路径解析 / 目录缺什么 / 缺了会怎样），支持 `--fix` 与 `--json`
- `scripts/sync-botplay.mjs`：botplay 运行时副本同步 CLI（薄封装 `lib/pure/botplay-sync.mjs`）
- `scripts/check-syntax.mjs`：全部 `.mjs` 语法自检（克隆即可跑）
- `package.json` 补 repository / homepage / bugs，scripts 增加 doctor / doctor:fix / sync:botplay

### Fixed

- **`.gitignore` 误排除了点歌解码器的必需文件**：`node_modules/` 与 `dist/` 规则把
  `lib/song/vendor/mp3dec/mpg123-decoder/dist/`（WASM 解码器主文件）和
  `lib/song/vendor/mp3dec/node_modules/`（28 个运行时依赖）一起忽略了 ⇒
  别人克隆下来 MP3 解码直接不可用。已加例外段 `!lib/song/vendor/**`。
- 补 `mpg123-decoder` / `@wasm-audio-decoders/common` 的 LICENSE 原文（上游包未带）

### Changed

- 开源脱敏（**只改注释/示例，代码逻辑零改动**，已逐文件 sha256 对比确认）：
  真实群名/群友昵称/openid/群号 → 占位符；作者环境绝对路径 → `{WORKSPACE_ROOT}` / `{DSH_HOME}`
- README 开头声明「这是扩展包，不是插件本体，需先装 `@zaofan/dsh-qqbot`」
- README 重写 botplay 章节：删掉已废弃的「dist 补丁」说法，改为启动时自动复制同步
- README 文件计数更正（21 命令 / 22 hooks / 15 inbound / 10 outbound / 17 tools / 116 lib）

### 说明

- 本轮**没有行为变更**：13 卡片、15 inbound、7 suites 448 条断言全部照旧通过
- 冷知识：上游 `ext-packs.js` 的 `EXT_KINDS` 数组里**写了** `botplay`，但没有任何代码拿它去扫 botplay —— 看数组里有名字 ≠ 真被支持


## [1.0.57] - 2026-11-23

### 修复（6 项 P0/P1，全部有实测证据）

- **botplay 13 张卡片全部加载失败**（P0）
  - 现象：`ERR_MODULE_NOT_FOUND`，点卡报「模块加载失败」
  - 根因：2026-11-23 把 `extension-store.js` 的扩展包回退补丁删掉改「复制同步」，
    但同步只搬顶层 `*.mjs`，不搬 `lib/` 依赖树
  - 修法：`lib/pure/botplay-sync.mjs` 增加两棵子树的递归复制
    （包内 `lib/` → `.qqbot-extensions/lib/`；`botplay/lib/` → `.qqbot-extensions/botplay/lib/`）
  - 连带修：vendored 依赖（`lib/song/vendor/mp3dec/node_modules/`）必须整包搬，
    否则 Node 解析 bare specifier 报 `Cannot find package`；`.wasm` / `package.json` 也在白名单内

- **主动逛（R5.7）今日 8/8 群全部 daily-cap**（P0）
  - 根因：13:48 一次会话内为测试写的 `jj.dailyProactive = 99`（不是脚本，工作区搜不到）
  - 修法：按日志实测真实次数修正（7 群今天各真逛过 1 次 → 写 1，不是 0）；清 12 个测试群残留

- **`inbound/bilibili-link.mjs` 从未生效**（P1）
  - 根因：只导出 `run(msg, env)`，而插件 `normalizeInbound` 只认
    `onInbound` / `onDecide` / `default(函数)` / `default.onDecide` / `default.middleware`
  - 修法：改成官方早挂点 `onInbound(ctx, next)`；**`ctx.rewrite` 收的是对象**
    `{ text, reason }` 不是字符串（传字符串会被静默拒绝）
  - 性能：`resolveConfig()` 原本每条消息 `readFileSync`，加 5 秒 TTL 缓存（实测 30×）

- **`tools/wake_lottery_card.mjs` 点击恒回「拿不到你的身份」**（P1）
  - 根因：`gidOf` 读 `ctx.peerId`，而真实回调 ctx 顶层**没有** `peerId`（群号在 `peer.groupId`）
  - 修法：取值链补 `peer.peerId`；用 `firstStr()` 而非 `??`（`??` 遇空串不跳过）
  - **防回归**：补 `scope === 'c2c'` 早退 —— 单聊时 `peer.peerId` 是对方 openid，
    不加会让它拿去拼 `/v2/groups/<openid>/messages`，比改前更糟

- **`outbound/56-roam-clean.mjs` 误伤正常消息**（P1）
  - 现象：`**注意**：明天两点` → `明天两点`；`https://...` → `//...`；换行被压平；
    `10-ensure-at-back` 刚补的 `<@openid>` 被剥掉
  - 根因：`sanitizeOutput` 本来只服务 R5.7，被挂到全局出站链后规则过激
  - 修法：`sanitizeOutput` 加三个开关（**默认 = 旧行为**，保住 444 条既有断言）；
    出站场景传 `{ stripNamePrefix:false, stripMentions:false, keepLines:true }`；
    并 pre-mask 保护合法 `<@openid>` / `[rf:]` / `[MEDIA:]`，只剥不合法的 `<@...>`

- **删掉注定被拒的兜底发信**（P1）
  - `hooks/roam-scheduler.mjs` 里 `wakeTo` 失败后用 `caps.api` 直发
    「（她本来想刷会儿 B站，但会话掉线了）」
  - 两个问题：① 无 msg_id 走主动消息，实测被平台拒（`主动消息失败, 无权限`）
    ② 系统报错文案顶着她的身份发群
  - 改为失败静默 + 记诊断日志

### 修复（执行过程中自己改出来又自己修掉的）

- **主动逛空烧当日额度**（P0）
  - 原顺序「先 `proactiveRoam`（内部已 bumpProactive）→ 再 `trySpeak`」
    ⇒ 被预算拦下时计数已被吃掉。实测 19:11:49 一次 tick 空烧 7 个群、0 条消息
  - 修法：`trySpeak` 提到 `proactiveRoam` 之前
  - 已回滚 7 个群的计数，并加 4 条断言固化（T7.2 预算顺序契约）

- **入站热路径无谓写盘**（P1）
  - `inbound/aab-file-to-attachment.mjs` 每条消息都 `Object.keys(ctx)` 反射 + 同步写盘
  - 修法：只在真带文件线索时才 trace；`QQBOT_FILE_TRACE=1` 可应急全开
  - 实测：30 条普通消息日志增长 **0 字节**

### 加固（给维护者）

- **`scripts/qqbot-preflight.mjs`**：botplay 判据从「字节相等」改成「**能真实 import**」；
  新增 inbound 导出形态检查（按插件 `normalizeInbound` 同一套候选集）
- **`维护/05-工具/check-card-commands.mjs`**：删掉「扩展包回退」（基于错误前提：
  以为 `EXT_KINDS` 含 botplay 就会被扫描，实际没有任何代码扫它）；
  `existsSync` 之后补真实 `import()`，并计入 `allOk`
- **`维护/05-工具/check-ext-imports.mjs`**：默认根改为「真源 + 运行时目录」都扫
- **`维护/04-测试/mock-central-load-order.mjs`**：硬编码 9 个 hook 改为按目录全量加载
- **`维护/04-测试/mock-roam-integration.mjs`**：新增 T7.2 预算顺序契约（4 条断言）

### 测试

- roam 7 套：**448 断言**（原 444 + 4 顺序契约）
- wakelottery 5 套：273 断言
- memoir 5 套：167 断言
- 全量回归：**8/8 通过**（历史首次，改前 7/8）
- 预检：**0 错 1 警**（唯一警告是 settings `.bak` 轮转，与本次无关）

### 已知遗留

- `〔B站:BVxxx〕` 标记能写进消息了，但**消费端未接线** ——
  全工作区只有这一处生成点，没有任何地方解析它去触发 `handleLink`。
  R5.7「群友发链接 → 被动响应」还差最后一段。
- `inbound/aac-image-to-path.mjs` 入站 `fetch`+落盘仍是热路径 IO，但它被 @ 才触发且是识图唯一入口，留观察。


## [1.0.56] - 2026-11-22

### 新增
- **R5.6 唤醒抽奖**：她「刚睡醒」时抽一次奖（A 自抽 / B 邀请群友），全量一次交付
  - `lib/wake-lottery/`（config / core / store / atlas / index / narrate + 9 个出口，约 2600 行）
  - `hooks/wake-lottery.mjs`（挂中央调度器，每 10 分钟检查）
  - `commands/抽.mjs`（`/抽` + `/抽奖图鉴`）
  - `botplay/wake-lottery.mjs`（邀请卡片）
  - 九种奖项：一句话 / 图片 / 积分 / 表情包 / 语音 / 歌 / 专属称呼 / 加倍券 / 隐藏款
  - 三层保底：永不空奖 / 连 5 次普通必出稀有 / 出口失败换奖
  - 八维情绪驱动权重（精力低→少语音，亲近度高→多语音）
  - 图鉴系统（按用户哈希，不跨群）

### 架构决策
- **先问可用池再抽**（`availableOutlets()` + `restrictToAvailable()`）：
  不是「抽到再降级」，而是「只在能兑现的奖项里抽」—— 用户永远拿到真实可兑现的东西
- **B 模式用 `ctx.emit` 不用 `appendWake`**：遵循全项目既有约定（避免多发一条消息）
- **A 模式 wake prompt 按官方三要点写**：自报家门 / 说清要做什么 / 禁止项
- **限频**：每群每天 7 次 / 同群 2 小时间隔 / 每人每天 3 次 / 全局每小时 5 群 / 装死窗 02-06

### 修复（开发过程中发现的两个真实缺陷）
- `voice.available()` 原先只判模块能否导入 → 误报可用，导致「抽到语音再换奖」，
  退化了架构承诺。改为**同时要求语音配置存在**
- `atlas.recordDraw()` 原先允许空 gid → 会写进 `unknown` 群，造成跨群污染。
  改为**空 gid 直接拒绝**

### 测试
- 277 条断言：core 75 / store 60 / prizes 54 / atlas 39 / integration 49
- 覆盖：10 条前置判定边界、权重归一化、八维调整、保底、换奖链、
  损坏自愈、时钟回拨、跨天重置、隐私哈希、测试隔离

### 配置
- `{EXT_DATA}/wake-lottery/config.json`，19 个字段全外置
- **默认 `enabled: false`**，灰度开启
- 环境变量 `BNN_WAKELOTTERY_*` 可覆盖（测试隔离）


## [1.0.55] - 2026-11-21

### 新增
- **R5.5 群回忆录**：`/回忆录 [天数]` 让机器人讲这个群最近发生了什么
  - `lib/memoir/`（clean / stats / narrate / index / config，约 1070 行）
  - `commands/回忆录.mjs`（204 行）
  - 两层流水线：读历史 → 清洗 → 统计 → 生成素材简报 → `wake` 交给 AI 用自己语气讲
  - 默认 7 天，上限 90；`minMessages=30` 以下提示「记录太少」
  - 配置：`{EXT_DATA}/memoir-config.json`，可用 `BNN_MEMOIR_*` 环境变量覆盖
  - 红线：只读历史 / 不写记忆 / 不含 openid / 不复述原话 / 失败不抛

### 变更
- **放弃「命令里自己调 LLM」的旧方案**：实测 `kernel.get('llm')` 在命令 handler 里
  探测路由不稳定（`NO_ROUTE` / `NARRATE_HARD_TIMEOUT 23000ms`），改为官方 `wake` 机制
  —— 扩展只算事实简报，人格/上下文/注入全部交给宿主

### 测试
- `mock-memoir-clean`（42）/ `-stats`（45）/ `-narrate`（28）/ `-integration`（28）/ `-command`：全部通过


### Changed — 回忆录改用官方 wake 机制（架构修正，2026-11-21）

**这是一次方向性纠错。** 前 6 轮修复（`listProviders` 返回形态 / cordis getter /
`listModels` 联网挂死 / chunk 协议 / AbortSignal / 总超时）都是在**错的方向上打补丁**——
真机症状始终是「发了 `/回忆录` 没反应，或拿到机械模板文案」。

**根因：不该自己调 LLM。**

官方早已提供 `wake` 机制（`middleware-setup.js:659`）：

```js
// 命令 handler 返回
{ wake: { content, senderName } }
// → 宿主当合成消息注入会话
// → AI 带完整人格 + 历史 + 八维情绪自己生成回复
// → 宿主发到 QQ
```

⇒ **LLM 调用、人格、上下文预算全是宿主的事**。我们已有的 `commands/唤醒.mjs`
就是这么写的（先用 `appendWake`，兜底返回 `wake` 字段）。

**新架构**：

| 层 | 职责 |
|---|---|
| `commands/回忆录.mjs` | 读历史 → 清洗 → 统计 → 生成**素材简报** → `appendWake` 交给 AI |
| `lib/memoir/stats.mjs` | 纯函数统计（本地算事实，AI 只负责润色，不会瞎编）|
| `lib/memoir/narrate.mjs` | **LLM 部分已删除**（300 行 → 120 行，只留模板供测试）|

**收益**：
1. 零 LLM 代码 ⇒ 不会挂死、不会降级、不需要 route 探测
2. 天然带完整人格 + 群上下文 + 八维情绪底色
3. 素材里的数字是本地算的事实，杜绝 AI 编造

**同时修的**：
- 清洗新增「卡片/小程序消息」规则（实测 `[卡片消息] 小程序 摘要: [QQ小程序]...` 会污染关键词）
- `mock-calendar-and-fortune.mjs` 加 wake 豁免（走 wake 的命令不算「必须走 markdown 通道」）

**测试**：新增 `mock-memoir-command.mjs`（28 条），回忆录总计 167 条。
旧 LLM 方案完整归档到 `维护/99-归档/R5.5-旧LLM方案-*/`。

---

### Fixed — 路由探测挂死（诊断日志定位的真凶，2026-11-21）

诊断日志的**决定性证据**：

```
13:47:25 HAS_LLM 准备流式调用
（之后什么都没有 —— 没有 STREAM_CALLED）
```

卡在 `HAS_LLM` 与 `STREAM_CALLED` 之间 ⇒ 只可能是 `resolveDefaultRoute()`。

查 `dsh-llm/lib/index.js:2206`：

```js
async listModels(provider) {
  const models = await this.registration(provider).adapter.listModels(provider);
  ...
}
```

—— `listModels` 会走 adapter，**可能是网络请求拉模型目录**，在插件进程里挂几十秒甚至不返回。

**而且我们根本不需要探测**：qqbot 的 config 里已经 pin 了模型
（`im-qqbot-2.json: provider=deepseek-account, model=deepseek-flash`）。

**修法**：路由解析改成三级，**优先零 IO 来源**。

| 优先级 | 来源 | IO |
|---|---|---|
| ① | 调用方显式 `opts.provider/model` | 零 |
| ② | **`ctx.config.provider/model`（qqbot 配置里 pin 的）** | 零 |
| ③ | 探测 `listProviders/listModels`（带 **3 秒超时**）| 可能联网 |

**验证**：探测接口故意抛错造桩 —— 若代码去探测就会失败。
结果 `config` 路由生效、探测**完全没被调用**；无来源时 1ms 内降级（不挂死）。
补 3 条回归断言（`mock-memoir-narrate.mjs` T6e）。

---

### Fixed — LLM 流式调用缺 signal + chunk 协议解析错（2026-11-21）

诊断日志显示：

```
13:35:52 HAS_LLM 准备流式调用
（之后什么都没有 —— 既没 LLM_OK 也没 LLM_THROW）
```

⇒ `llm.stream()` **挂死**。查 `@deepseek-ai/dsh-llm/lib/index.js:2522`：

```js
streamWithRegistration(options) {
  return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared));
}
adapterStream(options) {
  ...await adapter.prepareCall(options.provider, options.model, options.signal)
}
```

**两个 bug**：

**① 没传 `signal`** —— adapter 用 `options.signal` 做中止，
不传时某些 provider 会一直等 ⇒ 永久挂起（所以日志停在 HAS_LLM）。
**修**：建 `AbortController`，传 `signal`，并设超时自动 abort。

**② chunk 协议解析错** —— 宿主 chunk 是**带 type 的协议对象**：

| type | 含义 |
|---|---|
| `text` | 正文增量（**只收这个**）|
| `reasoning` | 思维链（**不能混进正文**）|
| `finish` | 终止，`reason.kind` 可能是 `error`/`aborted` |

原实现把所有 `chunk.text` 都拼进去 ⇒ **思维链会混进回忆录**；
且没处理 `finish`，出错时也当正常结束。
**修**：只收 `type==='text'`；`finish` 带 error 时抛错降级。

**验证**：按真实协议造桩 → `reasoning` 被排除、多 chunk 正确拼接、
`finish(error)` 触发降级、`signal` 确实传到了 stream。
补 5 条回归断言（`mock-memoir-narrate.mjs` T6d）。

**诊断增强**：`{EXT_DATA}/memoir-diag.log` 落盘记录
`NO_LLM / HAS_LLM / STREAM_CALLED / LLM_OK / LLM_THROW / LLM_EMPTY_OR_TIMEOUT`，
绕过 logger 级别过滤（这次排查就是靠它定位到「挂在 stream 调用」的）。

---

### Fixed — cordis getter 读取抛错导致 LLM 拿不到（2026-11-21）

**上一条修复后仍降级**，继续挖到更深一层：

```js
// 原实现（错）
const k = ctx?.caps?.kernel ?? ctx?.caps ?? ctx?.kernel ?? ctx?.ctx ?? ctx;
try { return k?.get?.(name); } catch { return undefined; }
```

两个致命点：

**① cordis Context 上的 `caps` / `ctx` 是 getter，未 inject 时「读取即抛」**

同一个坑早在 `commands/会话列表.mjs:335` 就记过：
> 踩过的坑（2026-10-14 实测报错 `cannot get property ctx without inject`）

原实现把 `ctx?.caps` 放进 **`??` 表达式**里顺手取——那一步就抛，
而外层 try **只包住了后面的 `k?.get`，包不住前面的属性读取** ⇒ 直接抛到调用方。

**② 即使不抛，优先取 `ctx.caps`（能力包对象）再 `.get(name)` 也不对** —— 能力包上没有 get。

**修复**：照抄 `会话列表.mjs:340-357` 已验证的写法 ——
逐个候选**单独 try**，先试 `kernel.get(name)`，再试 root/ctx/caps 三个句柄。

**验证**：用真实 cordis 形态造桩（`caps` getter 抛错）→ `mode: llm`。
补 3 条回归断言（`mock-memoir-narrate.mjs` T6c）。

**影响面**：小店文案润色、回忆录叙事 —— 两条链路同时恢复。

---

### Fixed — LLM 服务解析一直失败（2026-11-21）

**影响面**：回忆录的 LLM 叙事、小店的文案润色 —— **两条链路都在静默降级**。

**根因**：`lib/shop/adapters/llm-host.mjs` 的 `resolveDefaultRoute()` 把返回值当数组取，
但实测宿主 `@deepseek-ai/dsh-llm/lib/index.js:2028` 的实现是：

```js
listProviders() {
  return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
}
```

—— 返回**裸数组**，而代码里写的是 `providers?.[0]` 去取 `{ok, providers:[...]}` 形态。
两者不匹配时 `resolveDefaultRoute` 静默返回 `undefined` ⇒ 上层一律降级、不报错。

**现象**：群里 `/回忆录` 输出的是机械模板味（「这 7 天群里一共说了 640 句话…」），
而不是她自己的口吻 —— 因为 LLM 根本没被调起来。

**修复**：
1. 新增 `asArray()` 兼容两种返回形态（裸数组 / `{providers|models|items|data|list}` 包装）
2. `narrateLlm` 的 `llm.stream()` 调用改为**宿主的真实契约**：
   `system` 是顶层字段（原来错放进 messages），messages 每项需 `id/content[]/source`，
   并补 `maxTokens`
3. 补 5 条回归断言（`mock-memoir-narrate.mjs` T6b）：裸数组 / 对象包装 / stream 抛错 / 无 provider

**验证**：按真实契约造桩 → `mode: llm`，文本正确拼接。

---

### Added — R5.5 群回忆录（2026-11-21）

新命令 `/回忆录` —— 让她讲讲这个群最近发生了什么。

**流程**：读历史 → 清洗 → 统计 → 叙事（LLM 优先，失败退模板）

| 模块 | 职责 |
|---|---|
| `lib/memoir/clean.mjs` | 清洗 9 类噪声（@提及/引用块/表情占位/注入标记/伪造身份/平台占位…）|
| `lib/memoir/stats.mjs` | 统计（总数/人数/时段/排行/关键词）|
| `lib/memoir/narrate.mjs` | 叙事（LLM `kernel.get('llm')` 优先 → 模板保底）|
| `lib/memoir/config.mjs` | 配置（全部可覆盖，环境变量支持测试隔离）|
| `lib/memoir/index.mjs` | 编排（唯一有 IO 的地方，全部 try-catch）|
| `commands/回忆录.mjs` | 命令入口（薄壳）|

**实测数据**（Bnn的猫群喵 7 天）：
原始 1410 条 → 清洗后 797 条有效 → 输出 102 字回忆录。

**关键设计**：
- **必须先清洗**：不清洗时关键词全是噪声（`主人(164) 引用(70) 回复开(70)`）
- **LLM 走 `kernel.get('llm')`**：实测扩展能力包**没有** `ctx.llm`，
  复用现成的 `lib/shop/adapters/llm-host.mjs`
- **卡片回调拿不到 LLM**（实测 2026-10-13）⇒ 本期用命令不用卡片
- **不写记忆**：回忆录只发出去，不污染对话上下文

**测试 143 条**：clean 42 / stats 45 / narrate 28 / integration 28

**文档**：`lib/memoir/README.md` + 方案 + 接口契约

---

### Fixed — 小店买不了东西（2026-11-21）

**症状**（真机截图）：点「海苔 ¥8」→ 回「💸 买不了 / 积分服务暂时不可用，先不卖了」，
但用户积分正常、签到也能用。

**根因**：`botplay/shop.mjs` 的 `POINTS_DATA` 被误写成

```js
const POINTS_DATA = process.env.DSH_POINTS_ROOT;   // ❌ 没有回退
```

而该环境变量**只在测试时设置**，生产不设 ⇒ `undefined` ⇒ `createPoints({dataRoot: undefined})`
抛错 ⇒ 被 `catch {}` 吞掉 ⇒ 返回 `POINTS_UNAVAILABLE`。

同批重构里其余 6 个模块（daily-checkin / dice / fortune / points-board / rps / 积分）
都正确写成了 `const POINTS_DATA = POINTS_ROOT;`，**只有 shop.mjs 漏改**。

**修复**：
1. `POINTS_DATA = POINTS_ROOT`（走 `lib/dirs.mjs`，含 env 覆盖 + 默认值）
2. `catch` 不再是空的 —— 异常写进 `{EXT_DATA}/shop-points-error.log`，
   下次类似问题一眼能定位（这次排查完全没有任何日志，只能靠读代码）

**验证**：临时数据根模拟开张 → 下单，返回 `NO_MONEY`（真实余额不足）而非 `POINTS_UNAVAILABLE` ✅

**全库扫描**：无其他 `= process.env.X;` 无回退的同类写法。

---

### 计划中
- 五轴 → 八维心理状态（已在 persona 插件侧实现，待扩展侧联动完善）
- 开源文档完善（CONTRIBUTING、docs/）

### Added — 可移植性基建（2026-11-20，上架准备）

> 背景：本扩展要读写 `Bot/人格/`、`Bot/积分/`、`Bot/曲库/` 等一批**工作区约定目录**。
> 这些不是官方要求，别人装上本包时**一个都不存在** —— 以前靠作者机器上刚好有在跑。
> 上架前必须堵掉这条路。

- **`lib/dirs.mjs`**：工作区目录清单 + 首次运行自愈 + 缺失降级。
  - 10 个目录常量（`PERSONA_ROOT` / `POINTS_ROOT` / `SONG_ROOT` / `IMAGE_ROOT` …），全部 env 可覆盖
  - `ensureWorkspaceDirs()` 建 `required` 目录（绝不删/不覆盖）
  - `safeList()` / `dirAvailable()` 缺失时返回空、不抛
- **`hooks/zz-ensure-workspace.mjs`**：实例启动跑一次，建必需目录并把结果写到
  `{dataRoot}/.qqbot-extensions/data/workspace-dirs.json`（含"哪些可选目录还空着"的提示）。
  检测到 `PARTIAL_OVERRIDE`（只改数据根没改工作区根 = 疑似测试配置）时**拒绝写盘**。
- **`lib/pure/atomic.mjs`**：统一原子写（tmp+rename + Android FUSE `EPERM` 重试）。
- **`lib/pure/deps.mjs`**：第三方依赖四级解析（env → 包内 → 向上 → profile 兜底），失败给出明确装法。
- **`package.json`**：声明 `silk-wasm ^3.7.1` 依赖与 `engines.node >= 20`。
- **`lib/pack-paths.mjs`** 新增 `BNN_WORKSPACE_ROOT` / `WORKSPACE_ROOT_OVERRIDDEN` / `PARTIAL_OVERRIDE`。

### Fixed — 运行时/测试垃圾清理（2026-11-20）

清了约 **1GB** 累积垃圾，并**堵住泄漏源**（不只是删一次）：

| 类别 | 清理前 | 处理 |
|---|---|---|
| 系统 tmp 测试残留 | 1114 个目录 / **131MB** | 删到 70 个 / 3.7MB（剩下全是活跃 harness 目录） |
| 其中 mock 测试残留 | `guard-mock-*` 240 + `privacy-guard-mock-*` 205 + r4-ex 133 + rpscard/cardnav/gamecards/calc… | 全删 |
| pip 构建残留 | 65 个 / 32MB | 全删 |
| 包内开发残留 | `hooks/trim-agent-tools.mjs.bak-2026…`、`outbound/.bak-probe` | 删（开源不该带） |
| `.qqbot-extensions/lib/` | 436KB（11-15 的 lunar 副本 + 两个空目录） | 删（日历改走包内副本，已验 11 行完整） |
| qqbot dist 补丁备份 | 7 个 `.bak-pre-repair-*` / 152KB | 删（快照校验通过，8 补丁仍在位） |
| 轮转日志副本 | `file-to-attachment.jsonl.1` 262KB、`audit.jsonl.1` 524KB | 删 |
| 任务中心原子写残留 | 5 个 0 字节 `.tmp-*` | 删 |
| 失效语音缓存 | 29 个 / 376KB（旧 key 已不可达） | 删（按需重新生成） |
| 测试临时树 | `04-测试/.tmp/` 12 个 | 删 |

**堵住泄漏源（根因）**：

1. `mock-privacy-guard.mjs` / `mock-security-guard.mjs` **只建临时目录不删** ——
   跑 205/240 次就攒 205/240 个（占了大头）。已加 `process.on('exit')` 退出清理
   （assert 失败/提前 return 也会执行）。实测连跑净增 0。
2. 新增 `维护/05-工具/clean-tmp.mjs`：扫出「测试专用前缀 + 超 24h 的 harness 目录 +
   原子写残留」，默认只报告，`--apply` 才删。
3. 已挂入 `run-all-checks.mjs` 的【⑥ 清理临时垃圾】做收尾，每次全检完不留垃圾。

全检 8/8 通过。

### Changed — 适配 qqbot 1.13.20（2026-11-21）

上游 1.13.16 → 1.13.20 跨 4 个版本。**扩展契约文档逐字节未变**，8 个 dist 补丁目标文件
上游也**一个都没动**（逐字节校验）⇒ 补丁内容直接复用，另建 1.13.20 快照。

上游这版的主要变化（读代码确认，非猜测）：

| 变化 | 对我们的影响 |
|---|---|
| **表情彩蛋**：`【表情: XX】` → 真 QQ face（`U+0014`+id） | 🔴 **必须适配**（见下）|
| 出站顺序改为「先换表情 → 再跑出站扩展」 | 🔴 同上 |
| `strip-artifacts`：出站剥时间头/占位符（默认关） | 无重复实现，保持默认 |
| `turn-error`：回合异常策略化（默认 notify=旧行为） | 无冲突 |
| `latexHint`：LaTeX 提示块（默认关） | 未启用 |
| `chunker` 改成表情感知 | 官方自带，不需要我们做 |
| **inbound 伪造标签转义收窄** | 🟢 对我们有利：路由模板 `[s:xxx]` 不再被转成全角 |

**核心适配：表情安全层**

官方新顺序是 `OutboundBuffer.flush() → 换表情 → sendRichOutbound → 出站扩展链`
⇒ **我们的出站扩展拿到的是含裸控制字符的正文**。我们有 6 个模块会改正文
（拆气泡/正则清洗/脱敏/改标点/补 @/加前缀），切在 `U+0014` 与 id 之间就把表情拆散，
群里显示空白、**日志无痕**（上游自己也为此在 `chunker.js` 加了专门的边界判定）。

- 新增 `lib/pure/face-safe.mjs`：`maskFaces()` 把每个 face 换成**带序号**的私用区占位符，
  操作完 `restore()` 还原。还原是**无状态**的（第一版用递增游标，被测试抓出
  「分段还原会错位」，已改成占位符自带序号）。
- `60-split-bubbles`：拆分前掩码，拆完逐气泡还原。
- `40-strip-tool-leaks`：入口掩码，所有回写统一走 `emit()`（还原后再 rewrite）。
- 其余 6 个出站模块评估后无需改动（`10` 只补开头 @、`55` 只加前缀、`50-style-guard`
  只改全角空格/换行、`45` 正则不碰控制字符、`05`/`20`/`50-mood-driver` 只读或拦截）。
- 新增回归测试 `维护/04-测试/mock-face-safe.mjs`（25 条断言）：
  掩码/还原、单模块不吞表情、**端到端「官方换表情 → 我们 9 个出站模块」表情数不变**。
  下次升级 qqbot 时这是第一道防线。

### Fixed — 测试隔离缺陷（2026-11-21）

写上面那个测试时**自己犯了规范 §6.1 的错**：没设 `QQBOT_DATA_ROOT`，出站链把测试目标
`group:TESTGROUP…` 写进了生产的 `recent-replies.json` 去重指纹 ⇒ 再跑同一条被
`20-zz-dedupe-replies` 直接 annihilate，表现为「表情 2→0」的**假失败**。

已修：测试改用 `mkdtempSync` 临时数据根 + `BNN_WORKSPACE_ROOT` 双设（避免 PARTIAL_OVERRIDE
误判），退出时清理。生产里被污染的 2 个键（`group:TESTGROUP…`、`lastSentFingerprint`）已清除。

### Changed — 换新音色 Elysia_V5Turbo（2026-11-20 23:10）

主人在 App 里把音色换成 **Elysia_V5Turbo**（`v5turbo` 架构导入 + 换了参考音 + 重调参数），
需要同步三处。注意 **modelId 没变**（上游是「一个模型目录 = 一个 id」，换名/换参考音不动 id）：

| 项 | App 真源 | 同步后 |
|---|---|---|
| modelId | `imported-850dcc44-…`（显示名 `Elysia_V5Turbo`） | 不变 |
| temperature | 0.7 | ✅ |
| topK | 90 | ✅ |
| topP | 1.0 | ✅ |
| repetitionPenalty | 1.5 | ✅ |
| speed | 1.0 | ✅ |
| 参考文本 | `嗨想我了吗？不论何时何地，爱莉希雅都会回应你的期待。` | ✅ |
| 参考音 | `CharacterModels/…/prompt_wav/reference-66ae74a9-….wav`（539KB） | ✅ 已同步到工作区并部署 |

- **参考音改为「工作区副本 + 自动部署」**：新增 `referenceSource`
  （`人格/语音样本/Elysia_V5Turbo/ref.wav`）。App 那边的文件名带 UUID、会变，
  工作区这份才是可备份/可版本化的真源；`ensureReferenceAudio()` 会比对内容哈希，
  不一致就重新部署到 `files/refs/`（自愈，不再"文件存在就认为对"）。
- **修掉一个真隐患：语音缓存会发旧音色** 🔴
  缓存 key 原来只用了 `modelId`。而这次换音色 **modelId 没变** ⇒ 同一句话
  会命中**旧音色**的 SILK 文件、且永不重新生成，现象就是"改了配置没生效"。
  现在 key 改为**音色指纹**（引擎 + modelId + 语言 + 生成参数 + 参考文本 +
  参考音内容哈希），任意一项变化自动失效。实测：同配置命中 72ms、改温度后重新合成 1718ms。
- `check-voice-config.mjs` 升级：除参数外，现在也**比对参考文本与参考音哈希**，
  并支持 `--sync` 一键拉取 App 的参考音到工作区。

实跑验证：`Elysia_V5Turbo` 合成成功（32kHz 单声道 16bit，2.56s 音频 / 6.9s 计算），
完整链路「文字 → WAV → SILK 语音条」通（`speak()` 返回 `silkPath` + `durationSec`）。

### Fixed — 原子写残留自愈（2026-11-20）

`hooks/zz-ensure-workspace.mjs` 启动时清理任务中心 `state/**` 下**超过 1 小时**的
`*.tmp-*` 残留（原子写「写 tmp → rename」两步之间进程被杀会留下空文件）。
实测本机攒了 5 个 0 字节残留，被 preflight 判成「原子写异常」。
现在自动清理并记入 `workspace-dirs.json` 的 `tmpCleaned`（正在写的新 tmp 不会误删）。

### Fixed — 语音参数第二次漂移（2026-11-20）

Voicebox（genie_tts）的 **App UI 配置不会同步给 HTTP API**，所以
`lib/voice/config.mjs` 的 `genParams` 是手工抄的一份副本。主人在 App 里再调音，
副本就过期，而**从聊天里听不出来是配置问题**（只觉得"声音不太对"）。

本次实测 App（`/data/data/dev.rinstel.genie_tts/shared_prefs/voice_studio.xml`）
已调到 `0.91 / 82 / 0.88 / 1.69`，代码副本还停在 `0.5 / 69 / 0.4 / 1.25`：

| 参数 | App 真源 | 旧副本 | 现状 |
|---|---|---|---|
| temperature | 0.91 | 0.5 | ✅ 已同步 |
| topK | 82 | 69 | ✅ 已同步 |
| topP | 0.88 | 0.4 | ✅ 已同步 |
| repetitionPenalty | 1.69 | 1.25 | ✅ 已同步 |
| speed | 1.0 | (未传) | ✅ 已补 |
| modelId | `imported-850dcc44-…`（elysia_v2Pro） | 同 | ✅ 本来就一致 |

实跑验证：新参数合成 202KB WAV / 9.6s（CPU 模式）。

**防复发**：新增 `维护/05-工具/check-voice-config.mjs` —— 读 App 的 shared_prefs
与代码副本逐项比对，漂移即退出码 1 并直接打印"该改成什么"。已挂入
`run-all-checks.mjs` 的【③b 语音参数漂移】，无 root 时降级为提示不阻塞。

### Fixed — P0（2026-11-20）

- **卡片全废：botplay 是唯一不支持扩展包的扩展点** 🔴
  迁移到扩展包后，`/玩法` 等 12 张卡片全部报
  `模块文件不存在或读不到: {dataRoot}/.qqbot-extensions/botplay/xxx.mjs`，
  而 `/玩法` 会静默降级成文字清单（"卡片版发不出来，先看这个清单"）——
  从聊天界面完全看不出是路径问题。
  - **根因**（读官方 `dist/features/extension-store.js:247` 确认）：
    `loadBotplayExtensionModule()` 只从 `{dataRoot}/.qqbot-extensions/botplay/`
    取**纯文件名**；而 tools/commands/hooks/inbound/outbound 都走
    `scanExtFiles`/`extDirsFor` 会扫 `extension-packs/<pack>/<kind>/`。
    botplay 是六个扩展点里唯一漏掉扩展包支持的。
  - **为什么不直接复制过去**：复制后模块的相对 import（`../lib/pure/card-format.mjs`）
    会从 `.qqbot-extensions/` 解析，找不到包内 lib，仍然全挂；复制整套 lib 又变成两份真源。
  - **修法**：给上游加载器打第 8 个 dist 补丁 `QQBotPatch:botplay-pack-fallback`
    —— 内置目录优先（保持上游语义），找不到再按名字扫各扩展包的 `botplay/`。
    返回真实文件路径 ⇒ 包内模块的相对 import 照常解析。
    补丁已存入 `维护/补丁快照/qqbot-1.13.16/` 并在 preflight 加硬校验（marker 丢失即报错）。
  - 实测 12/12 模块全部从 `extension-packs/bnn-custom/botplay/` 加载成功。
- **语音缓存写错目录（真 bug，已产生脏数据）**：`lib/voice/index.mjs` 的
  `BOT_ROOT` 写成 `${DATA_ROOT}/Bot`，而 `DATA_ROOT` 已经是 `.../Bot/dshqqbot`
  ⇒ 缓存全写进 `.../dshqqbot/Bot/人格/语音缓存/`（实测已生成该嵌套目录）。
  按规范 §2.2 改为 `${WORKSPACE_ROOT}/Bot`；脏目录已删，7 个正常缓存保留。
- **人格根双真源**：`lib/io/persona-store.mjs` 自己算 `join(DATA_ROOT,'..','人格')`，
  与 `lib/dirs.mjs` 的 `PERSONA_ROOT` 是两套推导且不认 env 覆盖
  ⇒ 用户重定向后「建目录」与「读人格」指向不同目录、人格静默回落默认。现统一为单一真源。
- **`session_watch_lib` 路径推导**：原来用 `import.meta.url` 上推 4 级拼 `.qqbot-extensions`，
  不认 `QQBOT_DATA_ROOT`，内置布局下还会落错目录。改由 `pack-paths` 的 `EXT_DATA` 推导。
- **人格切换状态丢失**：`lib/io/persona-switch.mjs` 的 `saveState()` 无 EPERM 重试，
  失败时「会话已换、人格没存」，下次回旧人格且无自愈。现在返回 `{ok}` 并让调用方告知用户。
- **`lib/song/to-silk.mjs` 缺状态变量**（本轮重构引入）：`silkTried` / `silkMod` 未声明
  ⇒ 点歌发语音时 `ReferenceError`。已补。

### Fixed — 路径与规范（2026-11-20）

- 20 个模块的路径迁移到 `lib/dirs.mjs`：botplay 5 个、commands 4 个、shop/小店/
  persona-lint/shop-task/lottery/library/song-index/voice-index、会话列表/子会话的诊断路径。
- 10 处状态文件改原子写：会话列表(3)、子会话、persona-lint、zz-model-default、
  zz-version-guard、session_watch_lib、weekly-report 的 `history.json`、mood 侧。
- `@napi-rs/canvas` 迁到 `lib/pure/deps.mjs`（`botplay/pairing.mjs` 原来写死 `~/.dsh/profiles/web/...`）。
- `botplay/points-board.mjs` 不再用 `ctx.dir.split('.qqbot-extensions')` 反推数据根。
- `commands/会话列表.mjs` / `子会话.mjs` 不再丢弃 `writeJsonAtomic` 的 `{ok}`。
- 语音样本参考音去角色名硬编码：按目录扫 `Bot/人格/语音样本/**/*.wav`，或用 `BNN_VOICE_SAMPLE`。

### ⚠️ 重大陷阱（已写进 package.json 顶部注释）

**禁止给本包加 `"type": "module"`。**
包内含 UMD/CJS 依赖（`lib/lunar/lunar.js`、`lib/song/vendor/mp3dec/*`）。一旦声明
`type=module`，这些 `.js` 会被当 ESM 解析，UMD 的 `module.exports` 分支失效
⇒ **黄历静默降级为固定宜忌文案、点歌解码失效**。本包自有代码一律 `.mjs`，不需要该字段。
（2026-11-20 实际踩过：`/日历` 只剩 3 行，6 个 mock 测试报红。）

---

### Fixed — 形态归位审查（2026-11-20）

- **周报脚本迁入包内**：`inbound/weekly-report.mjs` 的子进程依赖
  `{Bot}/scripts/weekly-report.mjs` 移到 `lib/scripts/weekly-report.mjs`。
  此前整包不自包含（只拷 `extension-packs/` 会导致 `/周报` 失效），
  且脚本内写死两个绝对路径。现在默认路径由 `import.meta.url` 上溯推导，
  调用方显式传 `--dataRoot=` `--out=`。
- **`session_create` 工具失而复得**：该工具在官方示例目录与包内**两边同时被停用**
  ⇒ 运行时根本不存在。现将包内那份移出停用列表（官方那份保持停用避免同名重复）。
- **`commands/小店.mjs` 去写死路径**：`/absolute/path/.../groups.json`
  → `join(DATA_ROOT, '.qqbot', 'groups.json')`。此前 `QQBOT_DATA_ROOT` 测试隔离在此文件失效。
- **语音参考音 env 化**：`lib/voice/config.mjs` 的 `referenceAudioPath` / `referenceText`
  支持 `BNN_VOICE_REF_AUDIO` / `BNN_VOICE_REF_TEXT` 覆盖，换机换角色不必改代码。

---

## [1.0.54] - 2026-11-20

### Added

- **开源规范化**：全包零硬编码路径，改用 `lib/pack-paths.mjs` 统一推导
- **可移植性**：支持 `QQBOT_DATA_ROOT` 环境变量改道（测试隔离/多实例）
- **隐私脱敏**：移除代码中真实群号与 openid，改为环境变量配置
  - 周报群：`BNN_WEEKLY_GROUP`
  - 投票白名单：`BNN_VOTE_END_ALLOWED`
- MIT LICENSE（含素材/第三方依赖免责说明）
- 本 CHANGELOG

### Changed

- **扩展点重整**：25 个文件从运行时目录迁移进扩展包
  - `botplay/` 新增 12 个卡片（此前全在 `.qqbot-extensions/`）
  - `commands/` +3、`hooks/` +1、`inbound/` +1、`tools/` +5、`lib/` +7
- `pack-paths.mjs` 新增 `WORKSPACE_ROOT` 导出
  - 因为 `Bot/人格` 在 `DATA_ROOT` 的上一级，此前推导全部错误
- 所有 `${DATA_ROOT}/Bot/...` 修正为 `${WORKSPACE_ROOT}/Bot/...`

### Fixed

- **人格切换卡永久失效**：`overlayReady()` 只比对 pid，重启后必然 false
  - 改为「pid 对不上时，hook 文件存在即认为可用」并自动刷新标记
- `hooks/zz-tool-security-guard.mjs` 的 `CWD_PREFIX` 路径层级错误
- 4 个 botplay 模块的 `DATA_ROOT` 命名冲突（`const` 与 `import` 同名）
- 16 个测试文件的旧路径引用

### Removed

- 运行时 `.qqbot-extensions/` 下 25 个重复副本（已归位扩展包）
- 代码中 8 处个人署名（改为「主人」通用称谓）

---

## [1.0.53] - 2026-11-19

### Added

- **R5.3 爱莉真声**：语音引擎从 CloneTTS 切换到 Voicebox
  - 支持 GPT-SoVITS 专训权重（`elysia_v2Pro`）
  - 实测 RTF 0.66-0.79（CPU）
- **R5.2 真·听歌**：本地曲库点歌
  - 纯 JS mpg123-decoder（无需 ffmpeg）
  - 133 首曲库，30 秒裁剪 → SILK 语音
- `/点歌` 改为免费（原 20 分）

### Fixed

- **语音语速慢一倍**：CloneTTS `speed` 参数有 bug，传了就慢
  - 改为完全不传该参数
- 长句不停顿：文本清洗误删句末标点

### Changed

- 点歌交互改为卡片式（🎲 随机 / 📋 列表）

---

## [1.0.52] - 2026-11-18

### Added

- **R5.1 修活两个死功能**
  - `mood-tint`（情绪底色）此前从未生效
  - `sulk`（小脾气）此前从未触发
- 积分出口：`/点歌`（20 分）、`/抽奖`（30 分）

### Fixed

- **情绪功能静默失效**：出站扩展读 `ctx.target.peerId`（该字段不存在）
  - 真实字段是 `ctx.target.targetId`
  - 此前 726 次诊断记录全部 `samples=0/4`

### Removed

- 称号功能（主人要求）

---

## [1.0.51] - 2026-11-17

### Added

- **R5.0 她的小店**
  - 三档定价（基础 8 / 常规 14 / 进阶 25）
  - 今日特供（限量）
  - 精确库存 + 防死锁事务
- **积分系统**
  - 签到 +5 / 抽签看手气 / 猜拳赢+2输-1 / 骰子 +1
  - 跨群通用，每玩法每天 5 次
- 玩法列表卡 `playground`
- 签到卡 `daily-checkin`、排行榜卡 `points-board`
- 命令：`/签到` `/排行榜` `/玩法` `/积分` `/小店`

---

## [1.0.50] - 2026-11-15

### Added

- 日历卡 / 猜拳卡 / 抽签卡 / 骰子卡（全部改为 botplay 卡片式）
- 卡片底部统一「功能按钮」层（日历/骰子/抽签/来张图）

### Changed

- `commands/` 里直接发卡的模式改为走 botplay 事件
  - 根因：命令发的卡片按钮点了没人认

---

## 更早版本

v1.0.0 起的历史变更见仓库 Git 记录。