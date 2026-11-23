# 开源移植指南

> 本扩展包原为单人部署（"爱莉希雅"），已做到**路径零硬编码、依赖可降级**。
> 本文说明换到别人的环境要改什么。

---

## 一、开箱即用（不需要改任何代码）

只需要正确放置目录：

```
{WORKSPACE}/                    ← 工作区根（如 /sdcard/DSH）
├── Bot/
│   ├── 人格/                   ← 角色卡、规则、事实库
│   ├── 曲库/                   ← 可选：本地 MP3
│   ├── 美图库/                 ← 可选：随机图
│   ├── 事件库/                 ← 可选：生活素材
│   ├── 任务中心/tasks.json     ← 中央调度器配置
│   └── dshqqbot/               ← 数据根（QQBot 自动创建）
└── …
```

扩展包放在 `{DATA_ROOT}/extension-packs/bnn-custom/` 即可被自动扫描。

---

## 二、可选依赖（缺了会自动降级，不会报错）

| 能力 | 依赖 | 缺失时 |
|---|---|---|
| 点歌 | `曲库/` 有 mp3 | 点歌提示「曲库是空的」；唤醒抽奖的「一首歌」奖项自动移出池 |
| 语音 | `人格/语音配置.json` + TTS 服务 | `/语音` 提示未配置；唤醒抽奖「一段语音」自动移出池 |
| 随机图 | `美图库/` 有图片 | 相应奖项/命令降级 |
| 事件库 | `事件库/*.md` | 生活痕迹走 fallback 文案 |
| 积分/小店 | 无（内置） | — |

**设计原则**：`available()` 探测 + 可用池过滤，缺依赖时**功能消失但不报错**。

---

## 三、需要改的（改用你自己的设定）

### 3.1 默认人格名

有 8 处代码里写了 `'爱莉希雅'` 作为**兜底默认值**。改法二选一：

**A. 改配置（推荐，不用碰代码）**
```json
// {DATA_ROOT}/.qqbot-extensions/data/人格/persona-config.json
{ "version": 2, "defaultPersona": "你的角色名" }
```

**B. 改代码兜底**（只有配置文件也缺失时才用到）
```
lib/io/persona-store.mjs:37,42
lib/name.mjs:121,146
lib/song/library.mjs:28   ← SPECIAL_KEYWORDS（"她自己的歌"识别关键词）
lib/shop/index.mjs:38     ← 小店文案禁用词
```

### 3.2 用户可见文案

| 文件 | 内容 | 改法 |
|---|---|---|
| `botplay/song.mjs:88` | 「这是爱莉希雅的歌」 | 改成你的角色名 |
| `commands/语音.mjs:84` | 「音色是爱莉希雅」 | 同上 |
| `outbound/40-strip-tool-leaks.mjs:71` | 工具泄漏清洗词表 | 按你的角色卡结构调整 |

### 3.3 唤醒抽奖文案（R5.6）

已做到**文案全外置**：

| 内容 | 位置 | 说明 |
|---|---|---|
| 兜底金句 | `lib/wake-lottery/prizes/quote.mjs` 的 `FALLBACK_LINES` | 3 条通用句，无人格专属词 |
| 隐藏款 | `{EXT_DATA}/wake-lottery/secrets.txt` | 外部文件，一行一条 |
| 奖项名称 | `lib/wake-lottery/atlas.mjs` 的 `PRIZE_LABEL` | 9 个中文名 |
| 权重/限频 | `{EXT_DATA}/wake-lottery/config.json` | 19 字段全可配 |

---

## 四、验证移植是否成功

```bash
# 1. 语法
for f in $(find . -name '*.mjs' -not -path '*/node_modules/*'); do
  node --check "$f" || echo "FAIL $f"
done

# 2. 硬编码检查（必须 0 处）
grep -rn "/storage/emulated" --include="*.mjs" . | grep -v node_modules | grep -v "\*" | grep -v "//"
grep -rEn "\b[0-9A-F]{32}\b" --include="*.mjs" . | grep -v node_modules

# 3. 断链检查
node Bot/维护/05-工具/check-ext-imports.mjs

# 4. 卡片↔命令对照
node Bot/维护/05-工具/check-card-commands.mjs

# 5. 全量测试
node Bot/维护/05-工具/run-all-checks.mjs
```

---

## 五、路径机制（为什么不需要改路径）

所有路径从 `lib/pack-paths.mjs` 与 `lib/dirs.mjs` 出：

```js
EXT_ROOT        = {DATA_ROOT}/extension-packs/bnn-custom   （或内置 .qqbot-extensions）
DATA_ROOT       = qqbot 数据根，可用 QQBOT_DATA_ROOT 覆盖
WORKSPACE_ROOT  = Bot/ 的父目录，可用 BNN_WORKSPACE_ROOT 覆盖
EXT_DATA        = {DATA_ROOT}/.qqbot-extensions/data
```

**所有业务目录都可环境变量重定向**（`BNN_POINTS_ROOT` / `BNN_SONG_ROOT` / `BNN_IMAGE_ROOT` …），
这也是测试能做到零污染的原因。

---

*本文与 `README.md`（功能说明）、`CONTRIBUTING.md`（开发规范）配套。*
