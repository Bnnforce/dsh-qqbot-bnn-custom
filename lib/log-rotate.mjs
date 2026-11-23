/** 简单日志轮转：超过 maxBytes 就把当前文件改名为 .1，再追加。 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendLogRotating(file, line, maxBytes = 256 * 1024) {
  try {
    mkdirSync(dirname(String(file)), { recursive: true });
  } catch { /* ignore */ }
  try {
    const st = statSync(file, { throwIfNoEntry: false });
    if (st && st.size >= maxBytes) {
      try { renameSync(file, `${file}.1`); } catch { /* 并发/权限失败就继续追加 */ }
    }
  } catch { /* ignore */ }
  try { appendFileSync(file, String(line)); } catch { /* ignore */ }
}

export default appendLogRotating;
