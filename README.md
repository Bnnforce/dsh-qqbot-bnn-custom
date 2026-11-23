# 群聊玩法扩展

> **这是一个「扩展包」，不是插件本体。**
>
> 它不能单独运行，必须装在 [`@zaofan/dsh-qqbot`](https://www.npmjs.com/package/@zaofan/dsh-qqbot)
> 这个 QQ 机器人插件的扩展目录里，由插件负责加载。
> 插件本体是第三方作品，**不在本仓库内**。

给 DSH QQ 机器人用的扩展包：积分经济、小店、点歌、语音合成、卡片交互。

> 目录名 `bnn-custom` 为历史沿用（被数据路径与停用清单引用），**展示名以本文件标题为准**。
>
> 🩺 **装完先跑一次自检**：`node scripts/doctor.mjs`
> —— 一条命令看清「路径解析成了什么、哪些目录缺、缺了会怎样」。
>
> 📦 **换到别的环境部署 → 看 [`PORTING.md`](PORTING.md)**（可选依赖、需要改的设定、验证清单）

---

## 功能

### 玩法

| 命令 | 说明 |
|---|---|
| `/玩法` | 一张卡片进入全部玩法 |
| `/签到` | 每日签到 +5 分 |
| `/抽奖` | 消耗 30 分抽奖 |
| `/骰子` | 掷骰子（卡片可连点） |
| `/点歌` | 随机推荐她的歌单，附语音试听 |
| `/语音` | 把文字念出来（本地 TTS） |
| `/回忆录 [天数]` | 让她讲这个群最近发生了什么（R5.5）|
| `/唤醒抽奖` | 打开抽奖卡片；她刚睡醒时也会自己发（R5.6）|
| `/抽奖图鉴` | 看抽奖收集进度（R5.6）|

### 经济系统

- **积分**：跨群通用，签到 / 抽签 / 猜拳 / 骰子四源
- **小店**：每日开店打烊，三档定价 + 限量特供 + 精确库存
- **排行榜**：本群积分排名

### 唤醒抽奖（R5.6）

她"刚睡醒"时抽一次奖：一半自己抽了说出来，一半留个卡片给群友点。

- **九种奖项**：一句话 / 图片 / 积分 / 表情包 / 语音 / 歌 / 专属称呼 / 加倍券 / 隐藏款
- **三层保底**：永不空奖 → 连 5 次普通必出稀有 → 出口失败自动换奖
- **八维情绪驱动权重**：累了少给语音，黏人多给语音
- **图鉴**：按用户哈希记录收集进度，不跨群
- **限频**：每群每天 7 次、间隔 2 小时、每人每天 3 次、凌晨 2-6 点不抽

核心设计：**先探测可用出口，只在能兑现的奖项里抽**（不是抽到再降级）。

详见 [`lib/wake-lottery/README.md`](lib/wake-lottery/README.md)。

### 交互

- 全部玩法走 **QQ 卡片**（按钮点击，不用打字）
- 卡片底部统一功能按钮层，可互相跳转

---

## 安装

### 1. 前置要求

| 项 | 版本 |
|---|---|
| DSH | >= 0.2.2 |
| dsh-qqbot | >= 1.13.16 |
| Node.js | >= 20 |

### 2. 放入扩展包目录

把整个 `bnn-custom/` 目录放到 qqbot 的 `dataRoot` 下的 `extension-packs/` 里：

```
{dataRoot}/
└── extension-packs/
    └── bnn-custom/          ← 本扩展
        ├── qqbot-pack.json  清单（名称/版本/最低插件版本）
        ├── package.json     依赖声明（silk-wasm）
        ├── commands/        21 个斜杠命令
        ├── hooks/           22 个启动钩子
        ├── inbound/         15 个入站处理
        ├── outbound/        10 个出站装饰（顺序敏感）
        ├── tools/           17 个 AI 工具
        ├── botplay/         13 个卡片回调
        ├── lib/            116 个共享模块
        └── scripts/          自检脚本（doctor / check-syntax）
```

`dataRoot` 就是 qqbot 配置里的 `dataRoot`（没有显式配置时由插件自己推导）。
放进去就自动被发现，**不需要改任何配置文件**。

### 3. 装依赖（语音/点歌需要）

```bash
cd {dataRoot}/extension-packs/bnn-custom
pnpm add silk-wasm
```

> 不装也能跑 —— 只有 `/语音` 和 `/点歌` 的「发语音条」会降级为文字提示。
> 依赖解析顺序：`BNN_SILK_WASM` 环境变量 → 包内 `node_modules` → 向上查找 →
> DSH profile 的 `node_modules`（兜底）。所以如果你的 DSH 里已经装过 `silk-wasm`，
> 这一步可以跳过。

### 4. 首次运行会自动建目录

**你不需要预先创建任何数据目录。** 实例启动后 `hooks/zz-ensure-workspace.mjs`
会跑一次，把「必需目录」建出来（已存在则跳过，**绝不删除或覆盖**），并把结果写到：

```
{dataRoot}/.qqbot-extensions/data/workspace-dirs.json
```

里面会列出：建了什么、哪些必需目录建失败、哪些可选目录还空着（按需备料）。
目录本身建不出来（权限问题）时只告警，不影响其他功能。

**具体哪些自动建、哪些不建**：

| 类别 | 行为 |
|---|---|
| 必需目录（`Bot/人格/`、`Bot/人格/积分/`、`.qqbot-extensions/data/`） | ✅ 启动时自动建 |
| botplay 运行时副本 + `lib/` 依赖树 | ✅ 启动时自动复制同步 |
| 子系统状态目录（`data/roam/`、`data/wake-lottery/` …） | ✅ 首次写数据时自动建 |
| 可选素材目录（`曲库/`、`美图库/`、`事件库/` …） | ❌ **不自动建** —— 空目录没意义。缺素材时对应玩法友好降级 |

### 5. 装完自检（推荐）

```bash
cd {dataRoot}/extension-packs/bnn-custom
node scripts/doctor.mjs
```

一条命令看清三件事：

- **路径解析成了什么** —— `DATA_ROOT` / `WORKSPACE_ROOT` / `EXT_ROOT` / `EXT_DATA` 的实际值
- **哪些目录缺** —— 必需（红）/ 可选（灰），以及各自是干什么的
- **缺了会怎样** —— 会明确告诉你「点歌没反应是因为曲库没放」

```bash
node scripts/doctor.mjs --fix     # 顺手把必需目录建出来（等价于启动自愈）
node scripts/doctor.mjs --json    # 机器可读，给 CI / 脚本用
```

同目录还有 `node scripts/check-syntax.mjs`（全部 `.mjs` 语法自检，克隆下来就能跑）。

### 6. 重载扩展

在 QQ 里发送：

```
/tools-reload
```

命令类扩展需要重启 DSH 宿主才生效。

---

## 目录约定（重要：上架后别人没有这套目录）

本扩展要读写一批**工作区数据目录**。这些是**本项目的约定**，不是 QQBot 官方要求，
所以换一台机器、换一个人部署时，这些目录**大概率一个都不存在**。

处理方式是三层的，不需要你手动做任何事：

| 层 | 做法 | 效果 |
|---|---|---|
| ① 自动创建 | 首次运行建 `required` 目录 | 不去预处理也不会报错 |
| ② 优雅降级 | 缺失时返回空列表/友好提示，不抛 | 缺素材只有对应玩法不可用 |
| ③ 可重定向 | 全部目录支持环境变量覆盖 | 数据想放哪都行 |

### 目录清单

`★` = 首次运行自动创建（`required`）；其余为可选，用到时才建。

```
{workspace}/                       ← Bot/ 的父目录
└── Bot/
    ├── 人格/                       ★  人格卡、分层设定、人生清单
    │   ├── 积分/                   ★  积分账本
    │   ├── 小店/                      小店数据
    │   ├── 语音样本/                  参考音（按角色分子目录）
    │   └── 歌单缓存/                  点歌索引缓存
    ├── 曲库/                          本地音乐（自备）
    ├── 美图库/                        随机图/抽奖配图（自备）
    ├── 事件库/                        人生事件流
    ├── 任务中心/                      定时任务定义
    ├── 周报/                          周报输出
    └── dshqqbot/                  ← 这是 dataRoot
        ├── .qqbot/                    插件自身数据（官方维护，只读）
        └── .qqbot-extensions/
            └── data/              ★  扩展共享数据
```

### 环境变量重定向

想把某个目录放到外置卡或别处，设对应变量即可（相对路径按工作区解析）：

| 变量 | 覆盖 |
|---|---|
| `QQBOT_DATA_ROOT` | qqbot 数据根 |
| `BNN_WORKSPACE_ROOT` | 工作区根（`Bot/` 的父目录） |
| `BNN_PERSONA_ROOT` / `DSH_PERSONA_ROOT` | 人格根 |
| `BNN_POINTS_ROOT` / `DSH_POINTS_ROOT` | 积分 |
| `BNN_SHOP_ROOT` / `DSH_SHOP_ROOT` | 小店 |
| `BNN_VOICE_SAMPLE_ROOT` | 语音样本 |
| `BNN_PLAYLIST_CACHE_ROOT` | 歌单缓存 |
| `BNN_SONG_ROOT` | 曲库 |
| `BNN_IMAGE_ROOT` | 美图库 |
| `BNN_EVENT_ROOT` | 事件库 |
| `BNN_TASK_CENTER_ROOT` / `DSH_TASK_CENTER` | 任务中心 |
| `QQBOT_REPORT_DIR` | 周报输出 |

> ⚠️ 做测试时**必须同时设 `QQBOT_DATA_ROOT` 和 `BNN_WORKSPACE_ROOT`**。
> 只设前者会导致工作区根仍指向真实位置 —— 扩展检测到这种「半改道」状态会
> 拒绝写盘并记为 `skipped`，避免污染生产目录。

### 可选素材怎么备

| 功能 | 需要准备 | 格式 |
|---|---|---|
| `/点歌` | `Bot/曲库/**/*.mp3` | 文件名 `歌名 - 歌手.mp3` |
| `/语音` | `Bot/人格/语音样本/<角色>/*.wav` | 参考音 + 逐字文本（环境变量或配置） |
| `/抽奖`、随机图 | `Bot/美图库/*.jpg\|png` | 任意图片 |
| 人格功能 | `Bot/人格/角色卡/<名>.md`、`规则/` | Markdown |
| 小店 | 无需准备，首次开店自动生成 | — |

素材缺失时相关玩法返回友好提示，**不会报错、不影响其他功能**。

### ⚠️ 关于 `botplay/`（卡片回调）—— 唯一需要「复制同步」的扩展点

六个扩展点里，**`botplay` 是上游唯一不从扩展包加载的**：

```js
// @zaofan/dsh-qqbot 的 extension-store.js
botplayExtensionsDir(dataRoot) → {dataRoot}/.qqbot-extensions/botplay/
loadBotplayExtensionModule()   → 只接受「纯文件名」，不扫 extension-packs/
```

其余五个扩展点（`tools` / `commands` / `hooks` / `inbound` / `outbound`）都能直接在包里被扫到。

> 📌 常见误解：上游 `ext-packs.js` 的 `EXT_KINDS` 数组里**写了** `'botplay'`，
> 但**没有任何代码拿它去扫 botplay**。看数组里有名字 ≠ 真被支持。

**本包的处理：启动时自动复制（不需要你手动做任何事）**

`hooks/zz-ensure-workspace.mjs` 在实例启动时调用 `lib/pure/botplay-sync.mjs`，把：

| 从（本包 = 唯一真源） | 到（上游加载位置） |
|---|---|
| `botplay/*.mjs`（13 个卡片） | `{dataRoot}/.qqbot-extensions/botplay/` |
| `botplay/lib/*.mjs` | `{dataRoot}/.qqbot-extensions/botplay/lib/` |
| `lib/**`（卡片依赖的 116 个模块） | `{dataRoot}/.qqbot-extensions/lib/` |

内容相同就跳过（不反复写盘），源里没有的幽灵文件会清掉。

**为什么必须带上 `lib/`**：卡片里写的是相对 import（`../lib/pure/card-format.mjs`），
少了这棵依赖树，13 张卡片会全部 `ERR_MODULE_NOT_FOUND`，点开报「模块加载失败」。

**手动重跑 / 自检**

```bash
cd {dataRoot}/extension-packs/bnn-custom

node scripts/sync-botplay.mjs           # 同步（改完 botplay/ 或 lib/ 之后跑）
node scripts/sync-botplay.mjs --check   # 只检查，不写
node scripts/sync-botplay.mjs --force   # 强制全量覆盖
```

**症状识别**

| 现象 | 查什么 |
|---|---|
| 点卡片报「模块加载失败」 | `{dataRoot}/.qqbot-extensions/botplay/botplay-ext.log` 最后几行 |
| `/玩法` 只回文字清单、说"卡片版发不出来" | 同上，通常是没同步 |
| 卡片能开但按钮没反应 | 回调注册表，看 `~/.dsh/qqbot-dispatch-diag.log` |

---

## 扩展点

本扩展使用 QQBot 的全部六套扩展点：

| 目录 | 数量 | 作用 |
|---|---|---|
| `commands/` | 17 | 斜杠命令 |
| `hooks/` | 18 | 启动钩子（配置、调度） |
| `inbound/` | 14 | 入站消息处理 |
| `outbound/` | 9 | 出站消息装饰（**顺序敏感**） |
| `tools/` | 15 | AI 可调用的工具 |
| `botplay/` | 13 | 卡片事件（按钮回调） |
| `lib/` | 67 | 共享模块 |

### outbound 执行顺序

```
05-birthday-at-all    生日 @
10-ensure-at-back     保证 @
20-zz-dedupe-replies  去重
40-strip-tool-leaks   去内部标记
45-privacy-guard      隐私脱敏
50-mood-driver        情绪驱动（只读）
50-style-guard        风格守卫
55-sulk-prefix        小脾气前缀（改正文）
60-split-bubbles      分气泡
```

**改动顺序会影响行为，请勿随意调整文件名前缀。**

---

## 开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

核心规范：

```js
// ✅ 路径唯一入口（不要自己拼绝对路径）
import { EXT_ROOT, DATA_ROOT, WORKSPACE_ROOT, EXT_DATA } from '../lib/pack-paths.mjs';

// ✅ 工作区数据目录（统一从 dirs.mjs 取，含自动创建与降级）
import { POINTS_ROOT, SONG_ROOT, IMAGE_ROOT, safeList } from '../lib/dirs.mjs';

// ✅ 状态文件必须原子写（并发 + Android EPERM 重试都封在里面）
import { writeJsonAtomic, readJsonSafe } from '../lib/pure/atomic.mjs';

// ✅ 第三方依赖（不要写死 node_modules 路径）
import { loadPackage } from '../lib/pure/deps.mjs';
```

**设计要点**：本扩展不假设任何目录预先存在。
读目录用 `safeList()`（缺失返回空数组），写状态用 `writeJsonAtomic()`（自动建父目录），
目录由 `hooks/zz-ensure-workspace.mjs` 在首次启动时统一准备。

---

## 已知限制

| # | 限制 | 说明 |
|---|---|---|
| 1 | 曲库需自备 | `Bot/曲库/` 下放 `.mp3`，命名 `歌名 - 歌手.mp3` |
| 2 | 语音样本需自备 | 参考音与文本必须逐字匹配 |
| 3 | 卡片需要权限 | QQ 机器人需开通卡片能力 |
| 4 | 语音上限 60 秒 | 平台限制，自动裁剪到 30 秒 |
| 5 | 仅 Android 验证 | 路径推导支持跨平台，但未在其他平台测试 |

---

## 安全与隐私

- ✅ 不收集任何用户数据
- ✅ 所有数据存储在本地
- ✅ 不发起外部网络请求（除了用户显式配置的服务）
- ✅ 无设备控制、无屏幕读取能力
- ✅ 群友只能触发玩法，不能修改配置

---

## 版本历史

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 许可证

[MIT](LICENSE)

### 关于素材

本仓库**仅包含代码**。

《崩坏3》及其角色（含爱莉希雅）的版权归 miHoYo 所有。
音乐、图片、语音样本、模型权重等素材**不包含**在本仓库中，需自行合法获取。

---

## 致谢

- [DSH](https://github.com/deepseek-ai) — 宿主框架
- [dsh-qqbot](https://www.npmjs.com/package/@zaofan/dsh-qqbot) — QQ 通道
- `silk-wasm` / `mpg123-decoder` — 音频编解码