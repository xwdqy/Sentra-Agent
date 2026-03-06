import wsCall from '../../src/utils/ws_rpc.js';
import { ok, fail } from '../../src/utils/result.js';

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const url = String(penv.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || 15000));
  const path = 'message.recentContact';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  try {
    const resp = await wsCall({ url, path, args: [], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [], requestId }, response: resp });
  } catch (e) {
    return fail(e, 'ERR');
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
