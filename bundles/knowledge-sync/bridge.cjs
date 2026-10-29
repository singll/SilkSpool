// Supervise the official LiveSync CLI; this code never interprets CouchDB chunks.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { publish, atomicJSON } = require('./publish.cjs');
const stateRoot = process.env.STATE_ROOT || '/data';
const statusPath = path.join(stateRoot, 'bridge-status.json');
const settingsPath = path.join(stateRoot, '.livesync/settings.json');

async function main() {
  if (process.argv[2] === 'health') {
    const status = JSON.parse(await fs.readFile(statusPath, 'utf8'));
    if (!status.ready || Date.now() - status.checkedAt > 240000) throw new Error('LiveSync publication has not completed a recent healthy check');
    return;
  }
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  const bootstrap = JSON.parse(await fs.readFile(path.join(stateRoot, 'bootstrap-complete.json'), 'utf8'));
  if (!bootstrap.completedAt || !settings.encrypt || !(settings.passphrase || settings.encryptedPassphrase)) throw new Error('Encrypted LiveSync bootstrap is required');
  const vaultRoot = process.env.VAULT_ROOT || '/vault';
  const options = { sourceRoot: process.env.SOURCE_ROOT || '/source/vault', vaultRoot, targetPrefix: process.env.TARGET_PREFIX || '20-PKB/Bellkeeper', stateRoot };
  if (settings.syncOnlyRegEx !== '^20-PKB/Bellkeeper/') throw new Error('Refusing an unrestricted or mismatched server Vault');
  const monitor = JSON.parse(await fs.readFile(path.join(stateRoot, 'monitor.json'), 'utf8'));
  const secrets = [settings.couchDB_PASSWORD, settings.passphrase, monitor.password].filter(Boolean);
  const status = { ready: false, checkedAt: 0, startedAt: new Date().toISOString() };
  await atomicJSON(statusPath, status);
  // Seed before the CLI startup scan, avoiding a burst of NFS create events.
  const initialPublication = await publish(options);
  console.log(`[Publish] startup created=${initialPublication.created} updated=${initialPublication.updated} conflicts=${initialPublication.conflicts.length}`);
  const healthServer = http.createServer(async (request, response) => {
    if (request.url !== '/healthz') { response.writeHead(404); response.end(); return; }
    try {
      const current = JSON.parse(await fs.readFile(statusPath, 'utf8'));
      const healthy = current.ready && Date.now() - current.checkedAt < 240000 && current.publication?.conflicts === 0;
      response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', pending: current.pending, conflicts: current.publication?.conflicts, lastRemoteVerifiedAt: current.lastRemoteVerifiedAt }));
    } catch { response.writeHead(503); response.end('{"status":"unavailable"}'); }
  });
  healthServer.listen(3000, '0.0.0.0');
  let shuttingDown = false;
  let timer;
  let startupTimer;
  let shutdownTimer;
  let pendingSince;
  const child = spawn(process.execPath, ['/app/dist/index.cjs', stateRoot, '--vault', vaultRoot, '--interval', '30', 'daemon'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true; clearTimeout(timer); clearTimeout(startupTimer); healthServer.close();
    child.kill('SIGTERM');
    shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 30000);
    shutdownTimer.unref();
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const check = async () => {
    if (shuttingDown) return;
    try {
      const response = await fetch('http://sp-couchdb:5984/_up', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`CouchDB health HTTP ${response.status}`);
      const report = await publish(options);
      const range = new URLSearchParams({ startkey: JSON.stringify('20-pkb/bellkeeper/'), endkey: JSON.stringify('20-pkb/bellkeeper0'), include_docs: 'true' });
      const remote = await fetch(`${monitor.url}/_all_docs?${range}`, { headers: { Authorization: `Basic ${Buffer.from(`${monitor.user}:${monitor.password}`).toString('base64')}` }, signal: AbortSignal.timeout(30000) });
      if (!remote.ok) throw new Error(`CouchDB publication check HTTP ${remote.status}`);
      const rows = (await remote.json()).rows;
      const manifest = JSON.parse(await fs.readFile(path.join(stateRoot, 'publish-manifest.json'), 'utf8'));
      const documents = new Map(rows.filter(row => row.doc && !row.doc.deleted).map(row => [row.doc.path, row.doc]));
      let pending = 0;
      for (const relative of Object.keys(manifest.files)) {
        const name = `${options.targetPrefix}/${relative}`;
        let stat;
        try { stat = await fs.stat(path.join(vaultRoot, name)); }
        catch (err) { if (err.code === 'ENOENT') continue; throw err; }
        const doc = documents.get(name);
        if (!doc || doc.size !== stat.size || Math.abs(doc.mtime - stat.mtimeMs) > 2000) pending++;
      }
      status.ready = pending === 0; status.pending = pending; status.remoteFiles = documents.size;
      if (pending) pendingSince ||= Date.now(); else pendingSince = undefined;
      if (pendingSince && Date.now() - pendingSince > 300000) {
        console.error('[Bridge] Published files have not reached CouchDB for 5 minutes; restart to reconcile');
        process.exitCode = 1; stop();
      }
      if (status.ready) status.lastRemoteVerifiedAt = new Date().toISOString();
      delete status.error;
      status.checkedAt = Date.now(); status.publication = { source: report.source, created: report.created, updated: report.updated, conflicts: report.conflicts.length };
      await atomicJSON(statusPath, status);
      if (report.created || report.updated || report.conflicts.length) console.log(`[Publish] ${JSON.stringify(status.publication)}`);
    } catch (err) {
      status.ready = false; status.error = err.message;
      await atomicJSON(statusPath, status);
      console.error(`[Publish] ${err.message}`);
    }
    if (!shuttingDown) timer = setTimeout(check, 30000);
  };
  let initialized = false;
  function consume(stream) {
    let buffer = '';
    stream.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop();
      for (let line of lines) {
        for (const secret of secrets) line = line.split(secret).join('[REDACTED]');
        if (/^\[(Daemon|Error|Shutdown)\]|^\((Notice|Info)\).*?(Failed to |Error: |mismatch|corrupted)/i.test(line)) console.log(line.replace(/https?:\/\/[^\s]+/g, '[remote]'));
        if (line.includes('[Daemon] Initial replication complete') && !initialized) {
          initialized = true; clearTimeout(startupTimer); timer = setTimeout(check, 5000);
        }
        if (/\[Daemon\] Warning: (?:[5-9]|[1-9]\d+) consecutive failures/.test(line)) {
          console.error('[Bridge] Repeated replication failure; restarting through the container policy');
          stop(); process.exitCode = 1;
        }
      }
    });
  }
  consume(child.stdout); consume(child.stderr);
  startupTimer = setTimeout(() => { console.error('[Bridge] Replication startup timed out'); stop(); process.exitCode = 1; }, 600000);
  child.on('error', err => { console.error(err.message); stop(); process.exitCode = 1; });
  child.on('exit', code => {
    healthServer.close();
    clearTimeout(timer); clearTimeout(startupTimer); clearTimeout(shutdownTimer);
    if (!shuttingDown || code) process.exitCode = code || 1;
  });
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
