#!/usr/bin/env node
// Host-only bridge: private context arrives on stdin, never through model arguments.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 65536) throw Error('bridge context too large');
}
const context = JSON.parse(input);
const base = path.resolve(context.base), directory = path.resolve(context.directory);
const { createBus } = await import(pathToFileURL(path.join(base, 'plugins/sec-domain-bus/index.js')));
const { buildExecDomain } = await import(pathToFileURL(path.join(base, 'plugins/sec-domain-exec/index.js')));
const localData = path.join(directory, 'bus');
fs.mkdirSync(localData, { mode: 0o700 });
// The batch owns its dispatch/audit journal; signed HTTP evidence uses the installed
// exec domain's normal results directory and key. No task completion is fabricated.
const bus = createBus({ dataDir: localData, dbFile: path.join(localData, 'bus.sqlite'),
  auditFile: path.join(localData, 'audit.jsonl'), eventsDir: path.join(localData, 'events'),
  sidecars: false, startDispatcherTimer: false });
try {
  const domain = buildExecDomain({ dataDir: path.join(base, 'data'),
    egressProxy: context.connection.proxy,
    egressProxyAuthorization: context.connection.proxy_authorization,
    httpEgressBinding: context.binding,
    dispatch: (...args) => bus.dispatch(...args), query: (...args) => bus.query(...args) });
  const registered = bus.registry.register(domain);
  if (!registered.ok) throw Error('exec registration failed');
  const response = await bus.dispatch('exec', 'http_request', {
    program_id: context.binding.program, url: context.url, method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'SilkSecAgent-AnonymousPilot/1.0' },
    timeout_ms: 12000, max_bytes: 262144,
  }, { actor: 'script' });
  // Return only receipt metadata. Raw business content stays in signed evidence.
  console.log(JSON.stringify(response.ok
    ? { ok: true, ...response.data }
    : { ok: false, error_code: response.error?.code || 'E_EXEC_FAILED' }));
  process.exitCode = response.ok ? 0 : 1;
} finally {
  bus._internal.close();
}
