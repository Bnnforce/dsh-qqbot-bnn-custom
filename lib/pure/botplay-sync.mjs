/**
 * lib/pure/botplay-sync — botplay 模块同步（纯逻辑，零副作用）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（工业化改造 2026-11-23）
 *
 *   上游 `@zaofan/dsh-qqbot` 的 botplay 加载器只从
 *   `{dataRoot}/.qqbot-extensions/botplay/` 取**纯文件名**，
 *   是**唯一**不支持 extension-packs 的扩展点。
 *
 *   历史做法是打补丁改 `dist/features/extension-store.js`；
 *   现在改成「把上游位置当构建产物」——从扩展包复制过去。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 严重踩坑记录（务必保留）
 *
 *   第一版这个逻辑写在 `scripts/sync-botplay.mjs` 里，顶层有 `process.exit(main())`。
 *   hook 用 `await import('file://' + script)` 加载它 ⇒ **import 执行了顶层代码**
 *   ⇒ process.exit() 把整个 QQBot 进程杀掉 ⇒ **引擎一启动就炸**（主人实测）。
 *
 *   教训：**能被 import 的模块绝不能有顶层副作用**（不 exit、不写盘、不抛）。
 *   现在拆成两层：
 *     · 本文件 = 纯函数，import 无任何副作用
 *     · scripts/sync-botplay.mjs = 薄 CLI 封装，只有直跑时才 exit
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 踩坑记录 2（2026-11-23 R-01）：只复制顶层 .mjs ⇒ 依赖闭包缺失
 *
 *   上一版只 `readdirSync(src)` 复制 `botplay/*.mjs`，**不搬 lib/**。
 *   但 13 张卡片内部都是相对 import（`../lib/pure/card-format.mjs` 等），
 *   而 `{dataRoot}/.qqbot-extensions/lib/` 根本不存在
 *   ⇒ **13 张卡片全部 ERR_MODULE_NOT_FOUND**，用户侧表现是
 *     「⚠️ 这个事件的模块加载失败」，且 preflight 的旧判据（字节相等）还是 ✓ 通过的。
 *
 *   修法 = README「方案 B」早就写明的那条（不是新抽象）：
 *     ① 包内 `lib/`          → `{dataRoot}/.qqbot-extensions/lib/`          （递归）
 *     ② 包内 `botplay/lib/`  → `{dataRoot}/.qqbot-extensions/botplay/lib/`   （递归）
 *   两棵是**不同子树**，不能合并（顶层 lib 9 个 mjs、botplay/lib 只有 qq-media.mjs，虽无重名但语义不同）。
 *
 *   ⚠️ 另一个坑：`sameContent()` 原来对 >256KB 的文件退化成比 mtime，
 *      而 copyFileSync **会重写目标 mtime** ⇒ 像 lib/lunar/lunar.js（435KB）
 *      这种文件会「每次同步都判定不一致、每次都重写」，幂等性直接失效。
 *      现在大文件也比内容（见 sameContent 注释）。这在本轮 R-01 才暴露，
 *      因为以前 botplay 顶层没有大文件。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  existsSync, readdirSync, statSync, lstatSync, realpathSync,
  copyFileSync, mkdirSync, unlinkSync, readFileSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

/** 只同步这些扩展名。 */
export const BOTPLAY_EXTS = Object.freeze(['.mjs', '.js', '.cjs']);

/**
 * 额外必须同步的「非代码但 Node 解析要用」的文件名。
 *
 * ⚠️ 2026-11-23 实测踩到：`lib/song/vendor/mp3dec/mpg123-decoder/` 是一个
 * **已解包的 npm 包**，它自己就在 vendor 下、**不在** `node_modules/` 里，
 * 但 Node 解析 `import 'mpg123-decoder'` 时照样要读它的 `package.json`
 * （入口映射在 main/module/exports 里）。少了这个文件 ⇒ `Cannot find package`。
 *
 * `.wasm` 也在这里：WASM 解码器的二进制不是 `.js`，白名单会把核心组件整个漏掉。
 */
export const ALWAYS_SYNC_NAMES = Object.freeze([
  'package.json',
  'index.js',
  'index.mjs',
  'index.cjs',
]);
/** 额外必须同步的扩展名（二进制 / 类型声明 / sourcemap）。 */
export const ALWAYS_SYNC_EXTS = Object.freeze(['.wasm', '.json', '.d.ts']);

/**
 * 递归复制时整棵跳过的目录名。
 *
 * ⚠️ 2026-11-23 修正：**不再跳过 node_modules**（原值是 `['node_modules']`）。
 *
 * 为什么改：`lib/song/vendor/mp3dec/node_modules/` 里那 27 个文件
 * （`@wasm-audio-decoders/common`、`simple-yenc`、`@eshaz/web-worker`）是
 * **mpg123-decoder 的真实运行时依赖**（`MPEGDecoder.js` 直接 `import "@wasm-audio-decoders/common"`），
 * 不是构建期垃圾。它们是 `lib/` 这棵子树的组成部分，跳过就等于把点歌解码搬成半残。
 *
 * 补充说明（为什么当前没炸）：
 *   `lib/song/decode.mjs` 用 `${EXT_ROOT}/lib/song/vendor/...` 加载解码器，
 *   而 `EXT_ROOT` 指向**扩展包自身**（不是运行时副本）⇒ 点歌走的是包内那份，没受影响。
 *   但运行时 `lib/` 是给卡片用的公共依赖树，**不该有一棵半残的 vendor**：
 *   将来任何一处改成从运行时树加载，就会静默降级成「没有解码器」。
 *   多搬 27 个文件（约 1.3 MB）换确定的正确性，值。
 */
export const SKIP_DIR_NAMES = Object.freeze([]);

/**
 * 递归复制时**跳过的相对路径**（posix 风格，相对各自子树的根）。
 *
 * 为什么 `pure/botplay-sync.mjs` 不能搬（2026-11-23 R-01 实测踩到）：
 *
 *   它是**构建/维护期工具**（本文件自己），只被扩展包的 hook
 *   `hooks/zz-ensure-workspace.mjs` 从包内路径 import，**没有任何卡片引用它**。
 *
 *   一旦把它复制进 `{dataRoot}/.qqbot-extensions/lib/pure/`，preflight 的
 *   「内置树不得引用 extension-packs」检查立刻报错 —— 因为本文件里
 *   `join(dataRoot, 'extension-packs', 'bnn-custom')` 正是「跨树依赖」。
 *   那条检查是**对的**：运行时树不该有任何指向 pack 的路径引用。
 *   ⇒ 排除它，运行时树保持纯净（只放卡片真正需要的依赖）。
 *
 * ⚠️ 注意：`lib/scripts/weekly-report.mjs` 里也有 extension-packs 字样，
 *   但只出现在注释里（检查器会剥掉注释），且它是手工运维脚本、卡片不引用，
 *   复制过去无害，故不排除。
 */
export const SKIP_REL_FILES = Object.freeze(['pure/botplay-sync.mjs']);

/**
 * 内容比对的尺寸上限：超过它才退化为按 mtime 判等。
 *
 * ⚠️ 为什么不随手用 mtime 兜底：copyFileSync 会把目标 mtime 刷成「现在」，
 *   拿 mtime 判等 ⇒ 刚同步完立刻 check 依然「不一致」⇒ 每次启动都全量重写。
 *   阈值取 8MB，是为了避免极端大文件一次性读两份进内存；
 *   当前包内最大的 lib/lunar/lunar.js 只有 436KB，走的是**内容比对**。
 */
const MAX_CONTENT_COMPARE = 8 * 1024 * 1024;

/**
 * 递归深度上限（防御异常目录结构把启动期卡死）。
 * 当前包内最深是 `lib/song/vendor/mp3dec/node_modules/@wasm-audio-decoders/common/src/puff`（7 层），
 * 取 20 有充足余量。
 */
const MAX_DEPTH = 20;

/**
 * 两个文件内容是否一致。
 *
 * ⚠️ 不能用 mtime 判断：copyFileSync 会更新目标 mtime，
 *   导致同步完立刻再 check 仍然"不一致"（实测踩过）。
 *
 * 策略：size 不同 → 立即 false（最常见、最便宜）；
 *       size 相同 → 分块比内容（不整文件读入内存，避免大文件 OOM）。
 *       只有超过 MAX_CONTENT_COMPARE 的极端大文件才退化为 mtime 判等
 *       —— 当前包内最大的 lib/lunar/lunar.js 仅 436KB，仍走内容比对。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameContent(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    if (sa.size === 0) return true;
    if (sa.size > MAX_CONTENT_COMPARE) return Math.abs(sa.mtimeMs - sb.mtimeMs) < 1000;
    return sameContentChunked(a, b, sa.size);
  } catch {
    return false;
  }
}

/**
 * 分块比对两个等长文件。
 *
 * @param {string} a
 * @param {string} b
 * @param {number} size
 * @returns {boolean}
 */
function sameContentChunked(a, b, size) {
  const CHUNK = 256 * 1024;
  let fa = 0;
  let fb = 0;
  try {
    fa = openSync(a, 'r');
    fb = openSync(b, 'r');
    const ba = Buffer.allocUnsafe(CHUNK);
    const bb = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    while (pos < size) {
      const n = Math.min(CHUNK, size - pos);
      const na = readSync(fa, ba, 0, n, pos);
      const nb = readSync(fb, bb, 0, n, pos);
      if (na !== nb || na !== n) return false;
      if (!ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      pos += n;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fa) { try { closeSync(fa); } catch { /* ignore */ } }
    if (fb) { try { closeSync(fb); } catch { /* ignore */ } }
  }
}

/**
 * 递归收集一棵子树里的「可复制文件」相对路径（posix 风格，含子目录）。
 *
 * 防御点（都是踩过或必然会踩的）：
 *   · **符号链接环**：Android FUSE 上一般不支持软链，但别的文件系统会。
 *     这里对所有软链一律**跳过**（既防环，也避免把包外的东西拖进来）；
 *     另外用 realpath 集合再兜一层，防止 bind mount / hardlink 造成的重复遍历。
 *   · **深度保险**：超过 MAX_DEPTH 直接不收，避免异常目录结构把启动期卡死。
 *   · **node_modules**：整棵跳过（见 SKIP_DIR_NAMES 的说明）。
 *   · 只收 BOTPLAY_EXTS 三种扩展名。
 *
 * @param {string} root 绝对路径
 * @param {{skipFiles?:string[]}} [opts] skipFiles: 要跳过的相对路径（posix 风格）
 * @returns {{files:string[], dirs:string[], skippedLinks:number, errors:string[]}}
 */
export function collectTree(root, opts = {}) {
  const files = [];
  const dirs = [];
  const errors = [];
  const skipSet = new Set(Array.isArray(opts.skipFiles) ? opts.skipFiles : []);
  let skippedLinks = 0;
  const seenReal = new Set();

  const walk = (absDir, relDir, depth) => {
    if (depth > MAX_DEPTH) { errors.push(relDir || '.'); return; }
    let real;
    try { real = realpathSync(absDir); } catch { return; }
    if (seenReal.has(real)) return;   // 环 / 重复
    seenReal.add(real);

    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); }
    catch { errors.push(relDir || '.'); return; }

    for (const ent of entries) {
      const name = ent.name;
      const abs = join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;

      // 软链：一律跳过（防环优先）
      if (ent.isSymbolicLink()) { skippedLinks += 1; continue; }

      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      // Dirent 在部分文件系统上信息不全 → 用 lstat 兜底
      if (!isDir && !isFile) {
        try {
          const st = lstatSync(abs);
          if (st.isSymbolicLink()) { skippedLinks += 1; continue; }
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }

      if (isDir) {
        if (SKIP_DIR_NAMES.includes(name)) continue;
        dirs.push(rel);
        walk(abs, rel, depth + 1);
        continue;
      }

      if (!isFile) continue;
      // ★ 哪些文件要搬：
      //   ① 代码三种扩展名（.mjs/.js/.cjs）—— 卡片与 lib 本体
      //   ② vendored 依赖（路径里有 node_modules）**不限扩展名**：它们是完整 npm 包，
      //      Node 要读 package.json 的入口映射，WASM 组件还带 .c/.h/.wasm
      //   ③ 已解包到 vendor 下的包（不在 node_modules 里）也必须有 package.json/.wasm，
      //      否则 Node 同样报 Cannot find package（实测 mpg123-decoder 踩过）
      const inVendored = rel.split('/').includes('node_modules');
      const isCode = BOTPLAY_EXTS.some((e) => name.endsWith(e));
      const isAlways = ALWAYS_SYNC_NAMES.includes(name)
        || ALWAYS_SYNC_EXTS.some((e) => name.endsWith(e));
      if (!inVendored && !isCode && !isAlways) continue;
      if (skipSet.has(rel)) continue;   // 白名单排除（见 SKIP_REL_FILES）
      files.push(rel);
    }
  };

  walk(root, '', 0);
  return { files, dirs, skippedLinks, errors };
}

/**
 * 递归同步一棵子树（源 → 目标）。**永不抛**，失败只进 missing。
 *
 * @param {string} srcRoot
 * @param {string} dstRoot
 * @param {{force?:boolean, checkOnly?:boolean, skipFiles?:string[]}} opts
 * @returns {{copied:number, skipped:number, missing:string[], total:number,
 *            skippedLinks:number, errors:string[]}}
 */
export function syncTree(srcRoot, dstRoot, opts = {}) {
  const force = opts.force === true;
  const checkOnly = opts.checkOnly === true;
  const out = { copied: 0, skipped: 0, missing: [], total: 0, skippedLinks: 0, errors: [] };

  let collected;
  try { collected = collectTree(srcRoot, { skipFiles: opts.skipFiles }); }
  catch { return out; }

  out.total = collected.files.length;
  out.skippedLinks = collected.skippedLinks;
  out.errors = collected.errors;

  for (const rel of collected.files) {
    const s = join(srcRoot, rel);
    const d = join(dstRoot, rel);

    if (!force && sameContent(s, d)) { out.skipped += 1; continue; }
    if (checkOnly) { out.missing.push(rel); continue; }

    try {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
      out.copied += 1;
    } catch {
      out.missing.push(rel);   // 静默：只记账，不抛
    }
  }
  return out;
}

/**
 * 同步 botplay 模块：扩展包（唯一真源）→ 上游位置。
 *
 * 复制三处：
 *   ① `botplay/*.mjs`      → `{dataRoot}/.qqbot-extensions/botplay/`        （平铺，13 张卡片）
 *   ② `lib/**`             → `{dataRoot}/.qqbot-extensions/lib/`            （递归，卡片共用依赖）
 *   ③ `botplay/lib/**`     → `{dataRoot}/.qqbot-extensions/botplay/lib/`    （递归，卡片私有依赖）
 *
 * ⚠️ 返回结构向后兼容：老字段（copied/skipped/removed/total/missing/ghosts/reason）
 *   **仍然只描述 ①**（顶层卡片），下游 scripts/sync-botplay.mjs 与
 *   hooks/zz-ensure-workspace.mjs 的语义不变；②③ 的账目放在新增字段里。
 *
 * @param {{dataRoot:string, force?:boolean, checkOnly?:boolean}} opts
 * @returns {{
 *   ok:boolean, copied:number, skipped:number, removed:number,
 *   total:number, missing:string[], ghosts:string[], reason?:string,
 *   libCopied:number, libSkipped:number, libMissing:string[], libTotal:number,
 *   botplayLibCopied:number, botplayLibSkipped:number,
 *   botplayLibMissing:string[], botplayLibTotal:number
 * }}
 */
export function syncBotplayModules(opts) {
  const dataRoot = String(opts?.dataRoot ?? '').trim();
  const force = opts?.force === true;
  const checkOnly = opts?.checkOnly === true;

  const out = {
    ok: false, copied: 0, skipped: 0, removed: 0, total: 0, missing: [], ghosts: [],
    // 新增（子树账目）
    libCopied: 0, libSkipped: 0, libMissing: [], libTotal: 0, libPruned: [],
    botplayLibCopied: 0, botplayLibSkipped: 0, botplayLibMissing: [], botplayLibTotal: 0,
  };

  if (!dataRoot) { out.reason = 'no-data-root'; return out; }

  const packRoot = join(dataRoot, 'extension-packs', 'bnn-custom');
  const src = join(packRoot, 'botplay');
  const dst = join(dataRoot, '.qqbot-extensions', 'botplay');

  if (!existsSync(src)) { out.reason = 'no-src'; return out; }

  let files = [];
  try {
    files = readdirSync(src).filter((f) => BOTPLAY_EXTS.some((e) => f.endsWith(e)));
  } catch {
    out.reason = 'read-src-failed';
    return out;
  }

  if (files.length === 0) { out.reason = 'empty-src'; return out; }
  out.total = files.length;

  if (!checkOnly && !existsSync(dst)) {
    try { mkdirSync(dst, { recursive: true }); }
    catch { out.reason = 'mkdir-failed'; return out; }
  }

  // ① 复制顶层卡片模块（保持原有语义）
  for (const f of files) {
    const s = join(src, f);
    const d = join(dst, f);

    if (!force && sameContent(s, d)) {
      out.skipped += 1;
      continue;
    }

    if (checkOnly) { out.missing.push(f); continue; }

    try {
      copyFileSync(s, d);
      out.copied += 1;
    } catch {
      out.missing.push(f);
    }
  }

  // ② 递归复制包内 lib/ → {dataRoot}/.qqbot-extensions/lib/
  //
  //    卡片的相对 import 全是 `../lib/xxx.mjs`，落到目标位置后
  //    就是 `{dataRoot}/.qqbot-extensions/lib/xxx.mjs` —— 这棵树不存在就 13/13 全挂。
  {
    const libSrc = join(packRoot, 'lib');
    const libDst = join(dataRoot, '.qqbot-extensions', 'lib');
    if (existsSync(libSrc)) {
      const r = syncTree(libSrc, libDst, { force, checkOnly, skipFiles: SKIP_REL_FILES });
      out.libCopied = r.copied;
      out.libSkipped = r.skipped;
      out.libMissing = r.missing;
      out.libTotal = r.total;
      if (r.skippedLinks > 0) out.libSkippedLinks = r.skippedLinks;
    }

    // ✂ 清理「按新规则不该存在」的旧副本（例如上一版搬过去的 pure/botplay-sync.mjs）。
    //   只删 SKIP_REL_FILES 里列明的，不递归扫全树 —— 保守，避免误伤。
    //
    //   ⚠️ 不计入 `removed`：老字段 `removed` 的语义严格是「清理的幽灵卡片」，
    //      下游 scripts/sync-botplay.mjs 打印"清理 N 个"依赖这个语义。
    //      这里只记在新字段 `libPruned` 里，保持向后兼容不变味。
    if (!checkOnly && existsSync(libDst)) {
      for (const rel of SKIP_REL_FILES) {
        const p = join(libDst, rel);
        if (!existsSync(p)) continue;
        out.libPruned.push(rel);
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }

  // ③ 递归复制 botplay/lib/ → {dataRoot}/.qqbot-extensions/botplay/lib/
  //
  //    ⚠️ 与 ② 是**两棵不同子树**，不能合并：
  //      卡片里 `./lib/qq-media.mjs` 是相对**卡片所在目录**解析的。
  {
    const blSrc = join(src, 'lib');
    const blDst = join(dst, 'lib');
    if (existsSync(blSrc)) {
      const r = syncTree(blSrc, blDst, { force, checkOnly });
      out.botplayLibCopied = r.copied;
      out.botplayLibSkipped = r.skipped;
      out.botplayLibMissing = r.missing;
      out.botplayLibTotal = r.total;
      if (r.skippedLinks > 0) out.botplayLibSkippedLinks = r.skippedLinks;
    }
  }

  // ④ 清理幽灵：目标有、源没有的模块
  //
  //    ⚠️ 插件每次启动会把它自带的 examples/botplay/ 示例「只补不存在」地铺进本目录
  //      （实测 checkin-stats.mjs 反复出现）。这些不在我们的卡片里 ⇒ 必须删，
  //      否则会被当成幽灵事件模块，且下次启动又被塞回来，形成拉锯。
  //
  //    ★ 只清**顶层**，不递归进 lib/ —— lib 下的文件不由插件回填，
  //      乱删会误伤（保守：只报告不删）。
  if (existsSync(dst)) {
    try {
      const srcSet = new Set(files);
      for (const f of readdirSync(dst)) {
        if (!BOTPLAY_EXTS.some((e) => f.endsWith(e))) continue;
        if (srcSet.has(f)) continue;
        out.ghosts.push(f);
        if (!checkOnly) {
          try { unlinkSync(join(dst, f)); out.removed += 1; }
          catch { /* 删不掉下次再删 */ }
        }
      }
    } catch { /* ignore */ }
  }

  // ok 判据：卡片 + 两棵子树都齐才算过
  const allMissing = out.missing.length + out.libMissing.length + out.botplayLibMissing.length;
  out.ok = checkOnly
    ? (allMissing === 0 && out.ghosts.length === 0)
    : (allMissing === 0);

  if (!out.ok && !out.reason) {
    out.reason = checkOnly ? 'out-of-sync' : 'copy-failed';
  }
  return out;
}

export default {
  BOTPLAY_EXTS, SKIP_DIR_NAMES, SKIP_REL_FILES,
  sameContent, collectTree, syncTree, syncBotplayModules,
};
