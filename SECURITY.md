# 安全说明

## 数据在哪里

**全部在你自己机器上。** 没有云端、没有遥测、没有第三方上报。

| 数据 | 位置 |
|---|---|
| 人格卡 / 规则 / 事实库 / 黑话本 | `{工作区}/Bot/人格/` |
| 聊天记录（只读） | `{数据根}/.qqbot/msg-history/group_<群id>/` |
| 积分 / 小店 / 配对 / 日记状态 | `{数据根}/.qqbot-extensions/data/` |
| 关系数据 | 由 `dsh-bnnbotbox` 插件保管 |

**QQ 凭证**（AppID/AppSecret）由 DSH 的通道插件保管，本扩展包不读也不存。

## 会接触到什么

本扩展包处理这些个人信息：

- 群友昵称、openid（QQ 平台的账号标识）
- 聊天内容（点歌、识图、日记、回忆录、黑话本都会读）
- 群友生日（生日提醒功能，若群友主动说过）

详见 [`PRIVACY.md`](PRIVACY.md)。

## 边界设计

| 机制 | 作用 |
|---|---|
| **群隔离** | 每个群只读自己的聊天记录和记忆目录，绝不跨群 |
| **日记脱敏** | 日记正文喂 LLM 前，openid / 真名 / 昵称已替换成「有人 / 我」 |
| **主人门禁** | 写操作、管理命令默认仅主人（`isOwner` 检查） |
| **路径零硬编码** | 所有目录从 `lib/pack-paths.mjs` / `lib/dirs.mjs` 出，可环境变量重定向 |

## 网络请求

本扩展包只会访问两个外部域名：

| 域名 | 用途 |
|---|---|
| `api.bot.qq.com` | QQ 官方消息接口（发消息、取 access_token） |
| `api.bilibili.com` | B 站（点歌 / 识图的媒体信息） |

除此之外不发起任何其他外部请求。

## 报告漏洞

**请不要在公开 issue 里贴聊天正文或凭证。**

- 用 GitHub 的 [Private vulnerability reporting](https://github.com/Bnnforce/dsh-qqbot-bnn-custom/security/advisories/new)
- 或者发邮件到仓库 owner 的公开邮箱

我会在 7 天内回复。如果确认是漏洞，修复会优先于新功能。
