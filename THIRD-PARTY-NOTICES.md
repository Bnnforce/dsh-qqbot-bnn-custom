# 第三方组件许可声明

> 本仓库代码以 [MIT](LICENSE) 发布。但为了「克隆下来就能用」，部分第三方库以
> **源码内置（vendored）** 的形式放在 `lib/song/vendor/` 下 —— 它们各自仍受**原许可**约束。
>
> 本文件汇总这些组件及其许可。完整许可原文在各自的 `LICENSE` 文件里。

---

## 一、源码内置（vendored）的组件

位置：`lib/song/vendor/mp3dec/`

| 组件 | 版本 | 许可 | 作者 | 作用 |
|---|---|---|---|---|
| [`mpg123-decoder`](https://github.com/eshaz/wasm-audio-decoders/tree/master/src/mpg123-decoder) | 1.0.3 | **MIT** | Ethan Halsall | MP3 解码（WASM），用于点歌/语音 |
| [`@wasm-audio-decoders/common`](https://github.com/eshaz/wasm-audio-decoders) | 9.0.7 | **MIT** | Ethan Halsall | 上面那个的公共运行时 |
| [`simple-yenc`](https://github.com/eshaz/simple-yenc) | 1.0.4 | **MIT** | Ethan Halsall | WASM 数据编码 |
| [`@eshaz/web-worker`](https://github.com/eshaz/wasm-audio-decoders) | 1.2.2 | **Apache-2.0** | Ethan Halsall | Worker 兼容层 |

### ⚠️ 特别声明：`puff`

`@wasm-audio-decoders/common` 内含 `src/puff/`（`puff.c` / `puff.h` / `README`）。

**这部分不是 MIT**，而是 **zlib 许可**：

```
puff -- A Simple Inflate
Copyright (C) 2002-2013 Mark Adler, all rights reserved

This software is provided 'as-is', without any express or implied
warranty.  In no event will the author be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```

> 上游说明：此副本已由原作者**内联改造**进该库（见 `src/puff/README`）。
> 原始代码：<https://github.com/madler/zlib/tree/master/contrib/puff>

**完整原文**：`lib/song/vendor/mp3dec/node_modules/@wasm-audio-decoders/common/src/puff/puff.h`（文件头）

---

## 二、声明的运行时依赖（未内置）

在 `package.json` 的 `dependencies` 里声明，由使用方自行安装：

| 组件 | 版本要求 | 许可 | 作用 |
|---|---|---|---|
| [`silk-wasm`](https://www.npmjs.com/package/silk-wasm) | `^3.7.1` | **MIT** | 音频转 SILK 格式（QQ 语音条） |

> 不装也能跑：`/语音` 和点歌的「发语音条」会降级为文字提示。

## 三、不随本仓库分发的依赖

| 组件 | 许可 | 说明 |
|---|---|---|
| [`@zaofan/dsh-qqbot`](https://www.npmjs.com/package/@zaofan/dsh-qqbot) | 见其自身 LICENSE | **本包的宿主插件**，第三方作品，不在本仓库内，也不由本仓库分发 |

---

## 四、素材与角色版权（重要）

本仓库**只有代码**，不包含任何第三方素材：

| 类型 | 是否随仓库分发 | 说明 |
|---|---|---|
| 音乐（曲库） | ❌ 否 | 用户自备，版权归各自权利人 |
| 角色语音 / 原声 | ❌ 否 | 同上 |
| 图片（美图库） | ❌ 否 | 同上 |
| 人格卡 / 剧情文本 | ❌ 否 | 由使用者自行创作或提供 |
| 语音模型权重 | ❌ 否 | 同上 |

**原则：代码开源，素材私有。**

本包默认的人格名（如「爱莉希雅」）属于第三方作品《崩坏3》的角色，相关名称与设定的
权利归米哈游（miHoYo / HoYoverse）所有。本仓库**不主张**对其拥有任何权利，
也**不分发**任何官方素材。人格内容由使用者自行配置，仓库内代码本身不绑定特定角色。

---

## 五、如果你想替换掉这些内置依赖

`lib/song/decode.mjs` 的 `loadMp3Decoder()` 是唯一的加载点（走
`{EXT_ROOT}/lib/song/vendor/mp3dec/mpg123-decoder/index.js`）。

想换成 `npm i mpg123-decoder` 的版本：

1. `pnpm add mpg123-decoder`
2. 把 `loadMp3Decoder()` 里的候选路径改成裸包名 `'mpg123-decoder'`
3. 删掉 `lib/song/vendor/`

内置（vendored）而不是走 npm 依赖，是为了「不装依赖也能点歌」；
代价是仓库多 452 KB 并需要负责许可声明。两者都可以，看你的取舍。

---

*本文件的组件版本与许可以仓库内实际文件为准。若你升级了 vendor 里的库，请同步更新本文件。*
