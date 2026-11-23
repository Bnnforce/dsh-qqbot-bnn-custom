/** 当前 DSH Web 端口/URL：优先环境变量，其次进程参数 --port，最后 4145。 */
export function dshWebBase() {
  const env = String(process.env.DSH_WEB_URL || process.env.DSH_WEB || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const argv = Array.isArray(process.argv) ? process.argv : [];
  const i = argv.indexOf('--port');
  const port = i >= 0 ? String(argv[i + 1] || '').trim() : '';
  return `http://127.0.0.1:${port || process.env.DSH_ENGINE_PORT || '4145'}`;
}
export function settingsUpdateUrl() {
  return `${dshWebBase()}/api/qqbot-settings/update`;
}
