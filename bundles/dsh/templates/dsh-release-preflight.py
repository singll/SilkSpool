#!/usr/bin/env python3
"""Cache full contract gates by exact input; rehearse schema only on disposable SQLite copies."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time


def fingerprint(root):
    h=hashlib.sha256()
    for p in sorted(root.rglob('*')):
        if '__pycache__' in p.parts:
            continue
        if p.is_symlink():
            raise ValueError('preflight tree must not contain symlinks: '+str(p))
        if p.is_file():
            h.update(str(p.relative_to(root)).encode()+b'\0')
            with p.open('rb') as f:
                for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    h.update(Path(__file__).read_bytes())
    node=Path(shutil.which(os.environ.get('NODE_BIN','node'))).resolve(strict=True)
    h.update(str(node).encode())
    h.update(subprocess.check_output([str(node),'--version']))
    h.update(subprocess.check_output(['uname','-sm']))
    h.update(json.dumps({k:v for k,v in os.environ.items() if k.startswith(('SEC_', 'DSH_', 'NODE_')) or k=='PATH'},sort_keys=True).encode())
    # Contract assembly uses only local modules and Node built-ins.
    return h.hexdigest()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--templates',required=True)
    p.add_argument('--state',default='/tmp/sec-release-preflight')
    p.add_argument('--database',help='optional SQLite image; never migrated in place')
    p.add_argument('--force',action='store_true')
    a=p.parse_args();started=time.time()
    root=Path(a.templates).resolve(strict=True);state=Path(a.state).resolve()
    if state==root or root in state.parents or state in root.parents:
        raise ValueError('preflight state and templates must not overlap')
    state.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (state/'lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        key=fingerprint(root);out=state/'assembled';receipt=state/'passed.json'
        # A preserved assembled tree is needed for schema rehearsal. Verify its bytes before reuse.
        cached=False
        if receipt.exists() and out.exists() and not a.force:
            r=json.loads(receipt.read_text());cached=r.get('input')==key and r.get('assembled')==fingerprint(out)
        if not cached:
            with (state/'contracts.log').open('w') as log:
                env={**os.environ,'SEC_CONTRACT_OUT':str(out)}
                subprocess.run(['bash',str(root/'sec-contract-test-local.sh')],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
            if fingerprint(root)!=key: raise RuntimeError('templates changed during verification; rerun')
            receipt.write_text(json.dumps({'input':key,'assembled':fingerprint(out),'passed_at':time.time()}))
        result={'input':key,'contracts_cached':cached,'production_changed':False}
        if a.database:
            source=Path(a.database).resolve(strict=True)
            with tempfile.TemporaryDirectory(prefix='schema-drill-',dir=state) as tmp:
                db=Path(tmp)/'asset-graph.db'
                with contextlib.closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as c:
                    with contextlib.closing(sqlite3.connect(db)) as d:c.backup(d)
                js='''
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
const [filename,plugins]=process.argv.slice(1);
const db=new DatabaseSync(filename);
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
const count=t=>db.prepare('SELECT COUNT(*) n FROM "'+t.replaceAll('"','""')+'"').get().n;
const before=Object.fromEntries(tables.map(t=>[t,count(t)]));
const task=await import(pathToFileURL(plugins+'/sec-backend-task-sqlite/index.js'));
const endpoint=await import(pathToFileURL(plugins+'/sec-backend-endpoint-sqlite/index.js'));
task.createTaskSqliteBackend().factory(db);
endpoint.createEndpointBackend({dataDir:filename.substring(0,filename.lastIndexOf('/'))}).factory(db);
for(const t of tables) if(count(t)!==before[t]) throw new Error('migration changed row count: '+t);
if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('integrity');
console.log(JSON.stringify({tables_checked:tables.length,integrity:'ok',migration:'task+endpoint',services_started:false}));db.close();
'''
                r=subprocess.run([os.environ.get('NODE_BIN','node'),'--input-type=module','-e',js,str(db),str(out/'plugins')],check=True,capture_output=True,text=True)
                result['schema']=json.loads(r.stdout)
        result['seconds']=round(time.time()-started,2)
        (state/'last-run.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))

if __name__=='__main__':main()
