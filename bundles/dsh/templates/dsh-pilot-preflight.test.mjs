import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-preflight-'));
fs.mkdirSync(path.join(root, 'data'));
for (const name of ['sec-domain-scope', 'sec-backend-scope-file', 'sec-backend-scope-sqlite']) {
  const directory = path.join(root, 'plugins', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(templates, `dsh-plugin-${name}.js`), path.join(directory, 'index.js'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
}
const dnsFixture = path.join(root, 'dns-fixture.mjs');
// Only DNS resolution is replaced; the real installed policy and SQLite read
// are exercised. No target connection occurs in this preflight.
fs.writeFileSync(dnsFixture, `import dns from 'node:dns/promises';
dns.resolve4 = async () => {
  if (process.env.PILOT_TEST_DNS_FORBIDDEN) throw Error('Unexpected DNS requery');
  return [{address:'8.8.8.8',ttl:60}];
};`);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function run({ level = 'S', program = 'bytedance', ip = '8.8.8.8',
  scopeEntry = '*.fixture.invalid', rules = '', exclude = '', stale = false,
  snapshot, forbidDns = false } = {}) {
  const content = `version: 1
defaults:
  allow_risk: [passive, active]
programs:
  - name: bytedance
    scope:
      - "${scopeEntry}"
${exclude}${rules}
`;
  fs.writeFileSync(path.join(root, 'data/scope.yml'), content);
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE IF NOT EXISTS assets(host,type,program_id,level,state)')
c.execute('DELETE FROM assets')
c.execute('INSERT INTO assets VALUES(?,?,?,?,?)',('entry.fixture.invalid','web',sys.argv[2],sys.argv[3],'stable'))
c.commit()
`, path.join(root, 'data/asset-graph.db'), program, level]);
  const digest = stale ? '0'.repeat(64) : crypto.createHash('sha256').update(content).digest('hex');
  const argv = ['--import', dnsFixture,
    path.join(templates, 'dsh-pilot-preflight.mjs'), root, 'bytedance',
    'entry.fixture.invalid', ip, digest];
  if (snapshot) argv.push(JSON.stringify(snapshot));
  return spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, ...(forbidDns ? { PILOT_TEST_DNS_FORBIDDEN: '1' } : {}) } });
}

test('real scope policy and exact S Web asset accept the pinned public target', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt.target, ['8.8.8.8', 443]);
  assert.equal(receipt.asset.level, 'S');
});

test('automatic pin uses the retained DNS answer without a separate lookup', () => {
  const result = run({ ip: 'auto' });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.target[0], receipt.dns_snapshot.records[0].address);
  const repeated = run({ ip: receipt.target[0], snapshot: receipt.dns_snapshot, forbidDns: true });
  assert.equal(repeated.status, 0, repeated.stderr);
});

test('C-level and another Program cannot pass Web membership', () => {
  for (const input of [{ level: 'C' }, { program: 'another-program' }]) {
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exact S-level Web membership required/);
  }
});

test('global exclusion, expired scope and fixed-egress requirement block', () => {
  for (const input of [
    { exclude: '    exclude:\n      - "entry.fixture.invalid"\n' },
    { rules: '    expires_at: 2020-01-01\n' },
    { rules: '    rules:\n      fixed_egress_ip: true\n' },
    { scopeEntry: 'unrelated.invalid' },
  ]) {
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scope, risk, expiry or fixed egress rejected/);
  }
});

test('scope digest drift and stale DNS address reject without target traffic', () => {
  const staleScope = run({ stale: true });
  assert.notEqual(staleScope.status, 0);
  assert.match(staleScope.stderr, /scope digest changed/);
  const staleIp = run({ ip: '1.1.1.1' });
  assert.notEqual(staleIp.status, 0);
  assert.match(staleIp.stderr, /pinned address no longer resolves/);
});

test('valid TTL binding survives round-robin changes without DNS requery', () => {
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const snapshot = JSON.parse(first.stdout).dns_snapshot;
  const reused = run({ snapshot, forbidDns: true });
  assert.equal(reused.status, 0, reused.stderr);
  assert.deepEqual(JSON.parse(reused.stdout).dns_snapshot, snapshot);
});

test('expired, broadened or cross-host DNS binding fails closed', () => {
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const original = JSON.parse(first.stdout).dns_snapshot;
  for (const change of [
    { expires_at_ms: Date.now() - 1 },
    { expires_at_ms: original.resolved_at_ms + 301000 },
    { hostname: 'other.fixture.invalid' },
    { program: 'other-project' },
    { records: [{ address: '127.0.0.1', ttl: 60 }, { address: '8.8.8.8', ttl: 60 }] },
  ]) {
    const result = run({ snapshot: { ...original, ...change }, forbidDns: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DNS binding expired or invalid|public unicast IPv4 required/);
  }
});
