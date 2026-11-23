/**
 * bing_search.mjs — 已停用（占位文件，不要删除！）
 *
 * 为什么留个空文件而不是删掉：
 *   主插件启动时会把它自带的 examples/ext-tools/*.mjs「只补不存在」地铺进本目录，
 *   所以删掉 bing_search.mjs 后，下次启动/重载又会被自动塞回来（2026-10-21 实测复发）。
 *   这里保留同名文件但不导出任何工具（缺 name/run 会被插件安全跳过），
 *   既阻止示例回填，又不会注册 bing_search 工具。
 *
 * 联网搜索统一走内置 web_search / web_fetch。
 */
export const disabled = true;
