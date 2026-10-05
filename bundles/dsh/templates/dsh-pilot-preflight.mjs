#!/usr/bin/env node
// Read-only policy gate. Uses the installed authority, never a copied allowlist.
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [base, program, hostname, address, expectedDigest] = process.argv.slice(2);
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
if (checkTargetScope(address, scope, program, now).excluded_by) throw Error('IP excluded');
let timer;
const addresses = await Promise.race([
  dns.resolve4(hostname),
  new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DNS timeout')), 3000); }),
]).finally(() => clearTimeout(timer));
if (!addresses.includes(address)) throw Error('pinned address no longer resolves for host');
const code = `
import ipaddress,json,sqlite3,sys
ip=ipaddress.IPv4Address(sys.argv[1])
if not ip.is_global or ip.is_multicast: raise ValueError('public unicast IPv4 required')
c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True,timeout=1)
c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON')
rows=[dict(r) for r in c.execute('SELECT host,type,program_id,level,state FROM assets WHERE host=? AND type=?',(sys.argv[3],'web'))]
if len(rows)!=1 or rows[0]['program_id']!=sys.argv[4] or rows[0]['level']!='S': raise ValueError('exact S-level Web membership required')
print(json.dumps(rows[0]))
`;
const asset = JSON.parse(execFileSync('python3', ['-c', code, address,
  path.join(base, 'data/asset-graph.db'), hostname, program],
{ timeout: 2000, maxBuffer: 65536 }).toString());
if (hash(fs.readFileSync(scopePath)) !== expectedDigest) throw Error('scope changed during preflight');
console.log(JSON.stringify({ program, hostname, target: [address, 443],
  scope_sha256: expectedDigest, checked_at: new Date().toISOString(), asset,
  matched_entry: decision.matched_entry, identity: 'anonymous' }));
