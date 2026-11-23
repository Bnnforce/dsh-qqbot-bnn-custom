/**
 * session-watch-hook.mjs — 启动钩子：**重启后把「回合结束回灌」接回来**
 *
 * 背景（2026-10-13 主人定「做成持久化的本地存档，不要只靠内存」）：
 *   · **盯梢名单本身就以存档为准**：
 *     `{数据根}/.qqbot-extensions/tools/data/session-watch-watching.json`
 *     （和 `vote.json` 同一个 data 目录）—— register / 改档 / 取消都会落盘，
 *     所以**重启后名单不会丢**；
 *   · **但监听器是内存态**：回灌靠 `root.on('session/event', …)` 这个订阅，
 *     它随插件进程一起消失 ⇒ 重启后"名单还在、却没人听了"。
 *     这就是之前那个「重启后引用子会话没用了」的根因。
 *   ⇒ 所以本钩子只做一件事：`rehydrate(env.ctx)` = **读回存档 + 重装监听器**。
 *
 * 为什么写在这里：hooks/ 是插件**启动期**跑的（每次启动 / 重建网关都会走一遍），
 * 正是"把内存态重新接上"的唯一时机。
 *
 * ⚠️ **2026-11-02 修资源泄漏**：旧版 `dispose()` 只把 `state = null`，
 *    `rehydrate()` 挂上的 `session/event` 监听**从不卸载** ⇒ 网关每重建一次事件链上就多一条，
 *    同一个 `turn/end` 被重复回灌（N 次重建 = N 次回灌）。
 *    现在 dispose 显式调用 `lib.uninstallHook()` 摘监听，并与 `registerDispose` 双通道登记，
 *    即使引擎只走其中一条也能收干净。
 *
 * ⚠️ **改这个文件要重启宿主才生效**（hooks 是启动期加载，不走 /tools-reload）。
 */
export const name = 'session-watch-hook';

/** 本次 run 的现场（重建网关会有新的一份） */
let state = null;
/** 本次 run 加载到的库（dispose 要用它的 uninstallHook）；可能为 null（加载失败时）。 */
let libRef = null;

export default {
  name,

  async run(env) {
    state = { restored: 0, hooked: false };
    try {
      // 同一份库（tools/lib/）；不带 ?v= —— 名单走 globalThis 共享，无需新实例
      const lib = await import('../tools/lib/session_watch_lib.mjs');
      libRef = lib;
      const r = await lib.rehydrate(env.ctx);
      state.restored = Number(r?.restored ?? 0);
      state.hooked = !!r?.hooked;
      // 2026-11-02：显式登记清理函数 —— QQBot 契约里 registerDispose 与导出 dispose() 都会在
      // 插件卸载/网关重建时被调用；两条都登记，保证至少有一条生效（幂等，重复摘无副作用）。
      try {
        env?.registerDispose?.(() => { try { libRef?.uninstallHook?.(); } catch { /* ignore */ } });
      } catch { /* ignore */ }
      env.logger.info(
        `[ext-hook:session-watch] 启动恢复：读回 ${state.restored} 条盯梢，` +
        `回灌监听器${state.hooked ? '已装' : '未能装上'}` +
        `（名单存档 tools/data/session-watch-watching.json）`,
      );
      return { restored: state.restored, hooked: state.hooked };
    } catch (err) {
      // 钩子里的失败不要往外抛：抛了也只是被引擎记成"失败"，不如降级 + 留日志
      const msg = String(err?.message ?? err);
      env.logger.warn(`[ext-hook:session-watch] 启动恢复失败（不影响其它功能）: ${msg}`);
      return { restored: 0, hooked: false, error: msg };
    }
  },

  /**
   * 引擎在插件卸载 / 宿主退出 / 重建网关时调用。
   * 2026-11-02：**真正卸载 `session/event` 监听**（旧版只清 state，监听留在链上泄漏）。
   */
  async dispose() {
    try { libRef?.uninstallHook?.(); } catch { /* 卸载失败不影响其它清理 */ }
    libRef = null;
    state = null;
  },
};
