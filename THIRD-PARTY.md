# 第三方组件声明

本仓库使用以下第三方代码。均在本机运行，不上传任何数据。

## 打包进仓库（vendor）

| 组件 | 版本 | 许可证 | 用途 | 位置 |
|---|---|---|---|---|
| [mpg123-decoder](https://github.com/eshaz/wasm-audio-decoders) | 1.0.3 | MIT | MP3 解码（点歌功能） | `lib/song/vendor/mp3dec/mpg123-decoder/` |
| [simple-yenc](https://github.com/eshaz/simple-yenc) | 1.0.4 | MIT | 二进制编解码（上面那个的依赖） | `lib/song/vendor/mp3dec/node_modules/simple-yenc/` |

两者的完整许可证文本已在各自目录的 `LICENSE` 文件中。

## 运行时依赖（不打进包）

| 组件 | 许可证 | 用途 | 提供方 |
|---|---|---|---|
| `@zaofan/dsh-qqbot` | 见其仓库 | QQ 通道 | 使用者自行安装 |
| `@deepseek-ai/cordis` | 见其仓库 | 插件框架 | DSH 自带 |
| `silk-wasm` | 见其仓库 | 语音编码 | 由通道插件提供 |

## 本仓库的许可证

本仓库原创部分：**MIT**（见 `LICENSE`）。

## 关于 AI 生成内容

机器人输出的每句话都是模型生成内容，不构成事实性主张或专业建议。

## 更新记录

- 2026-11-26：首次建立。补充 mpg123-decoder / simple-yenc 的许可证声明。
