# 贡献指南

感谢你愿意参与改进这个扩展。

---

## 开发环境

| 项 | 要求 |
|---|---|
| DSH | >= 0.2.2 |
| dsh-qqbot | >= 1.13.16 |
| Node.js | >= 20 |

---

## 快速开始

```bash
# 1. 克隆到扩展包目录
cd {dataRoot}/extension-packs

# 2. 确认目录结构
ls bnn-custom/
# 应该看到：commands/ hooks/ inbound/ outbound/ tools/ botplay/ lib/

# 3. 重载扩展（不重启 DSH）
# 在 QQ 里发：/tools-reload
```

---

## 提交前检查

**必须全部通过**：

```bash
cd {dataRoot}/extension-packs/bnn-custom

# ① 语法（必须 0 错误）
for f in $(find . -name '*.mjs'); do
  node --check "$f" 2>&1 | head -2
done

# ② 零硬编码路径
grep -rn "'{WORKSPACE_ROOT}\|'/data/data/\|'/data/user/0/" \
  --include='*.mjs' . | grep -v 'process\.env'
# 期望：无输出

# ③ 无真实群号/openid
grep -rnE '[0-9A-F]{32}' --include='*.mjs' .
# 期望：无输出

# ④ 全量测试
cd {dataRoot}/../test
P=0;F=0
for t in mock-*.mjs; do
  node "$t" >/dev/null 2>&1 && P=$((P+1)) || { F=$((F+1)); echo "❌ $t"; }
done
echo "通过 $P / 失败 $F"

# ⑤ preflight
node scripts/qqbot-preflight.mjs | tail -3
# 期望：0 个错误
```

---

## 代码规范

### 路径

```js
// ✅ 唯一入口
import { EXT_ROOT, DATA_ROOT, WORKSPACE_ROOT, EXT_DATA } from '../lib/pack-paths.mjs';

// ✅ 包内模块
`${EXT_ROOT}/lib/pure/game-core.mjs`

// ✅ 数据目录（Bot/ 下）
`${WORKSPACE_ROOT}/Bot/人格/积分`

// ❌ 绝对禁止
'/home/you/project/Bot/人格/积分'
```

### 错误处理

```js
// ✅ 所有 IO 必须 try-catch
try {
  const data = JSON.parse(readFileSync(p, 'utf8'));
} catch {
  return DEFAULT;   // 降级，不抛
}
```

### 状态文件

```js
// ✅ 原子写
const tmp = target + '.tmp';
writeFileSync(tmp, JSON.stringify(data));
renameSync(tmp, target);
```

### 日志

```js
// ✅ 用 env.log
env.log('[myext] 信息');

// ❌ 不用 console.log
console.log('debug');
```

### 注释

```js
/**
 * 为什么需要这个函数（不是做了什么）。
 *
 * 历史背景：2026-11-20 发现 xxx bug，根因是 yyy。
 * 官方契约依据：docs/extension-contract.md:123
 */
```

---

## 新增功能流程

```
1. 查官方文档（docs/extension-contract.md）
   ├─ 有现成 API → 直接用
   └─ 没有 → 继续

2. 判断归属
   ├─ 斜杠命令 → commands/
   ├─ 定时任务 → hooks/
   ├─ 消息预处理 → inbound/
   ├─ 回复装饰 → outbound/
   ├─ AI 工具 → tools/
   └─ 卡片交互 → botplay/（必须！）

3. 写 lib 纯函数（可单测）

4. 写扩展点（薄壳）

5. 写测试（临时目录隔离）

6. 跑四步检查

7. 更新 CHANGELOG
```

---

## 测试要求

```js
// 标准模板
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'mytest-'));

// ★ 必须隔离，不碰生产数据
process.env.QQBOT_DATA_ROOT = TMP;

try {
  // 测试
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
```

**必须覆盖**：正常路径 / 边界 / 异常 / 降级。

---

## PR 要求

| # | 要求 |
|---|---|
| 1 | 一个 PR 只做一件事 |
| 2 | 必须通过全部检查 |
| 3 | 必须更新 CHANGELOG |
| 4 | 新增功能必须带测试 |
| 5 | 不引入新依赖（除非充分理由）|

---

## 禁止事项

| # | 禁止 | 原因 |
|---|---|---|
| 1 | 硬编码绝对路径 | 无法移植 |
| 2 | 提交真实群号/openid | 隐私泄露 |
| 3 | 提交 API Key | 安全事故 |
| 4 | 提交素材（音乐/图片/模型）| 版权 |
| 5 | 命令里直接发按钮卡片 | 点了没人认 |
| 6 | 用 `ctx.target.peerId` | 该字段不存在 |
| 7 | ESM 里用 `require` | 运行时错误 |
| 8 | 测试写生产目录 | 污染数据 |

---

## 报告问题

提交 issue 时请附：

- DSH 版本
- dsh-qqbot 版本
- 复现步骤
- 相关日志（**先脱敏群号/openid**）

---

## 许可证

贡献的代码默认以 MIT 许可证发布，见 [LICENSE](LICENSE)。