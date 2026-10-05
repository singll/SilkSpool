#!/usr/bin/env node
// Read-only policy gate. Uses the installed authority, never a copied allowlist.
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [base, program, hostname, requestedAddress, expectedDigest, boundDns] = process.argv.slice(2);
if (!base || !path.isAbsolute(base) || !program || !hostname
    || !/^[a-z0-9.-]+$/.test(hostname) || !/^[a-f0-9]{64}$/.test(expectedDigest || '')) {
  throw Error('invalid preflight context');
}
const { checkTargetScope, parseExpiry } = await import(pathToFileURL(
  path.join(base, 'plugins/sec-domain-scope/index.js')));
const { parseScopeYaml } = await import(pathToFileURL(
  path.join(base, 'plugins/sec-backend-scope-file/index.js')));
const scopePath = path.join(base, 'data/scope.yml');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const raw = fs.readFileSync(scopePath);
if (hash(raw) !== expectedDigest) throw Error('scope digest changed');
const scope = parseScopeYaml(raw.toString('utf8'));
const now = Date.now();
const decision = checkTargetScope(`https://${hostname}/`, scope, program, now);
const cfg = decision.program_cfg;
if (!decision.allow || !cfg || !scope.defaults.allow_risk.includes('active')
    || !['active', 'intrusive'].includes(cfg.rules.max_risk)
    || cfg.rules.fixed_egress_ip
    || (cfg.expires_at && (parseExpiry(cfg.expires_at) === null || parseExpiry(cfg.expires_at) <= now))) {
  throw Error('scope, risk, expiry or fixed egress rejected');
}
// Bind one DNS answer for at most its shortest TTL (capped at five minutes).
// Re-querying a round-robin hostname per dial can reject a still-valid pin.
let snapshot;
if (boundDns) {
  snapshot = JSON.parse(boundDns);
  if (snapshot.version !== 1 || snapshot.hostname !== hostname || snapshot.program !== program
      || snapshot.scope_sha256 !== expectedDigest || !Number.isSafeInteger(snapshot.resolved_at_ms)
      || !Number.isSafeInteger(snapshot.expires_at_ms) || snapshot.resolved_at_ms > now
      || snapshot.expires_at_ms <= now || snapshot.expires_at_ms - snapshot.resolved_at_ms > 300000
      || !Array.isArray(snapshot.records) || !snapshot.records.length
      || snapshot.records.some(row => typeof row?.address !== 'string'
        || !Number.isInteger(row.ttl) || row.ttl <= 0)
      || snapshot.expires_at_ms > snapshot.resolved_at_ms + Math.min(...snapshot.records.map(row => row.ttl)) * 1000) {
    throw Error('DNS binding expired or invalid');
  }
} else {
  let timer;
  const records = await Promise.race([
    dns.resolve4(hostname, { ttl: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DNS timeout')), 3000); }),
  ]).finally(() => clearTimeout(timer));
  if (!records.length || records.some(row => !Number.isInteger(row.ttl) || row.ttl <= 0)) {
    throw Error('DNS answer has no reusable TTL');
  }
  snapshot = { version: 1, hostname, program, scope_sha256: expectedDigest, records,
    resolved_at_ms: now, expires_at_ms: now + Math.min(300, ...records.map(row => row.ttl)) * 1000 };
}
const addresses = snapshot.records.map(row => row.address);
// Select from the same answer that is retained for the whole batch.
const address = requestedAddress === 'auto' ? addresses[0] : requestedAddress;
if (!addresses.includes(address)) throw Error('pinned address no longer resolves for host');
if (checkTargetScope(address, scope, program, now).excluded_by) throw Error('IP excluded');
const code = `
import ipaddress,json,sqlite3,sys
for raw in json.loads(sys.argv[5]):
 ip=ipaddress.IPv4Address(raw)
 if not ip.is_global or ip.is_multicast: raise ValueError('public unicast IPv4 required')
c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True,timeout=1)
c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON')
rows=[dict(r) for r in c.execute('SELECT host,type,program_id,level,state FROM assets WHERE host=? AND type=?',(sys.argv[3],'web'))]
if len(rows)!=1 or rows[0]['program_id']!=sys.argv[4] or rows[0]['level']!='S': raise ValueError('exact S-level Web membership required')
print(json.dumps(rows[0]))
`;
const asset = JSON.parse(execFileSync('python3', ['-c', code, address,
  path.join(base, 'data/asset-graph.db'), hostname, program, JSON.stringify(addresses)],
{ timeout: 2000, maxBuffer: 65536 }).toString());
if (hash(fs.readFileSync(scopePath)) !== expectedDigest) throw Error('scope changed during preflight');
if (Date.now() >= snapshot.expires_at_ms) throw Error('DNS binding expired during preflight');
console.log(JSON.stringify({ program, hostname, target: [address, 443], dns_snapshot: snapshot,
  scope_sha256: expectedDigest, checked_at: new Date().toISOString(), asset,
  matched_entry: decision.matched_entry, identity: 'anonymous' }));
