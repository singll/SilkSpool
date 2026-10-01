#!/usr/bin/env python3
"""Bounded online backups and offline restore drills. No production restore or service start."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
import uuid


def save(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def regular(path):
    return path.is_file() and not path.is_symlink()


def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()


class Maintenance:
    def __init__(self, cfg):
        self.cfg=cfg
        self.base=Path(cfg['base']).resolve(strict=True)
        self.state=Path(cfg['state']).resolve()
        if self.state==self.base or self.base in self.state.parents: raise ValueError('state must be outside backup source')
        self.state.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.roots={'base':self.base}
        for index,value in enumerate(cfg.get('extra_roots',[])):
            root=Path(value).resolve(strict=True)
            if not root.is_dir() or root==Path('/') or root==self.state or root in self.state.parents or self.state in root.parents:
                raise ValueError('invalid additional backup root')
            if any(root==other or root in other.parents or other in root.parents for other in self.roots.values()):
                raise ValueError('backup roots overlap')
            self.roots['extra-'+str(index)]=root
        self.repo=cfg['repository']
        self.sftp=self.repo.startswith('sftp:')
        if self.sftp:
            if not re.fullmatch(r'sftp:[a-z_][a-z0-9_-]*@[a-zA-Z0-9._-]+:/[a-zA-Z0-9/_-]+', self.repo): raise ValueError('invalid SFTP repository')
        else:
            self.repo=Path(self.repo)
            self.mount=Path(cfg['mount'])
            if not self.mount.is_absolute() or self.mount not in self.repo.parents: raise ValueError('repository must be below NAS mount')
        self.keep=int(cfg.get('keep_last',8))
        if not 2<=self.keep<=32: raise ValueError('keep_last must be 2..32')
        self.host=cfg.get('host','csai')

    @contextlib.contextmanager
    def lock(self):
        with (self.state/'maintenance.lock').open('a') as f:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            yield

    def mounted(self):
        # SFTP cannot silently fall back to a local path. Mounted repositories verify origin.
        if self.sftp:
            for name in ('ssh_key','known_hosts'):
                if not regular(Path(self.cfg[name])): raise RuntimeError('missing SFTP key/known_hosts')
        else:
            r=subprocess.run(['findmnt','--json','--mountpoint',str(self.mount),'-o','TARGET,SOURCE,FSTYPE'],capture_output=True,text=True,check=True)
            fs=json.loads(r.stdout)['filesystems'][0]
            if fs['source']!=self.cfg['mount_source'] or fs['fstype'] not in ('nfs','nfs4','cifs'):
                raise RuntimeError('unexpected NAS source/type')
            if self.repo.resolve().parent!=self.mount.resolve(): raise RuntimeError('repository escaped NAS mount')
        key=Path(self.cfg['password_file'])
        if not regular(key) or key.stat().st_mode & 0o077: raise RuntimeError('password file must be regular and mode 0600')

    def restic(self, args, timeout=7200):
        self.mounted()
        env={**os.environ,'RESTIC_REPOSITORY':str(self.repo),'RESTIC_PASSWORD_FILE':self.cfg['password_file'],
             'RESTIC_CACHE_DIR':str(self.state/'cache')}
        command=['restic']
        if self.sftp:
            import shlex
            destination=self.repo[5:].split(':',1)[0]
            ssh=['ssh','-i',self.cfg['ssh_key'],'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
                 '-o','UserKnownHostsFile='+self.cfg['known_hosts'],'-o','ConnectTimeout=15','-o','ServerAliveInterval=15',
                 '-o','ServerAliveCountMax=3',destination,'-s','sftp']
            command+=['-o','sftp.command='+shlex.join(ssh)]
        r=subprocess.run(command+args,env=env,capture_output=True,text=True,timeout=timeout)
        if r.returncode: raise RuntimeError(f'restic {args[0]} failed ({r.returncode}): '+r.stderr[-1200:])
        return r.stdout

    def space(self):
        v=shutil.disk_usage(self.base)
        used=round(100*v.used/(v.used+v.free),1)
        free_min=int(self.cfg.get('min_free_bytes',20*1024**3))
        return {'used_percent':used,'free_bytes':v.free,'level':'critical' if used>=90 or v.free<free_min else 'warning' if used>=80 else 'ok'}

    def status(self):
        report={'disk':self.space(),'last_backup':None,'nas_ready':False}
        for name in ('last-backup','last-drill','last-check'):
            p=self.state/(name+'.json')
            if p.exists(): report[name.replace('-','_')]=json.loads(p.read_text())
        try:
            self.restic(['snapshots','--json','--latest','1'],timeout=45); report['nas_ready']=True
        except (RuntimeError,subprocess.SubprocessError,OSError): pass
        last=report['last_backup']
        report['backup_stale']=not last or time.time()-last['finished_at']>int(self.cfg.get('max_backup_age_seconds',86400))
        return report

    def excluded(self, path, root=None):
        rel=path.relative_to(root or self.base)
        return any(x in {'.cache','.pnpm-store','__pycache__'} for x in rel.parts) or str(rel).startswith(('data/backups/','backups/')) or str(rel) in ('data/backups','backups')

    def database_images(self):
        current=self.state/'current'
        current.mkdir(exist_ok=True)
        images=current/'sqlite'
        images.mkdir(exist_ok=True)
        dbs=[]
        def walks():
            for name,root in self.roots.items():
                # Application install trees cannot contain mutable business databases.
                for parent,dirs,files in os.walk(root/'data' if name=='base' else root,followlinks=False):
                    dirs[:]=[d for d in dirs if d!='node_modules' and not self.excluded(Path(parent)/d,root) and not (Path(parent)/d).is_symlink()]
                    yield name,root,parent,files
        for root_name,root,parent,files in walks():
            for name in files:
                p=Path(parent)/name
                if not regular(p) or self.excluded(p,root): continue
                with p.open('rb') as f: is_db=f.read(16)==b'SQLite format 3\x00'
                if not is_db: continue
                rel=p.relative_to(root)
                target=images/root_name/rel
                target.parent.mkdir(parents=True,exist_ok=True)
                tmp=target.with_name(target.name+'.pending')
                tmp.unlink(missing_ok=True)
                deadline=time.monotonic()+120
                def progress(*_):
                    if time.monotonic()>deadline: raise TimeoutError('SQLite backup busy >120s')
                with contextlib.closing(sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=3)) as src:
                    with contextlib.closing(sqlite3.connect(tmp)) as dst:
                        src.backup(dst,pages=1024,progress=progress,sleep=0.02)
                        if dst.execute('PRAGMA quick_check').fetchall()!=[('ok',)]: raise RuntimeError('SQLite quick_check failed')
                tmp.replace(target)
                metadata=p.stat()
                dbs.append({'path':str(rel),'image':str(target),'sha256':digest(target),
                            'source_root':str(root),'image_path':str(target.relative_to(current)),
                            'mode':stat.S_IMODE(metadata.st_mode),'uid':metadata.st_uid,'gid':metadata.st_gid})
        keep={d['image'] for d in dbs}
        for p in images.rglob('*'):
            if regular(p) and str(p) not in keep: p.unlink()
        save(current/'manifest.json',{'kind':'online-per-db-consistent','base':str(self.base),'created_at':time.time(),'databases':dbs,
            'limitations':'Live files and separate databases are not one global transaction. Use held freeze for cutover.'})
        return dbs

    def backup(self):
        self.mounted()
        if self.space()['level']=='critical': raise RuntimeError('insufficient staging headroom; run cleanup/status first')
        started=time.time()
        dbs=self.database_images()
        batch='batch-'+uuid.uuid4().hex
        args=['backup','--json','--host',self.host,'--tag','routine-pending','--tag',batch,'--exclude-caches']
        for root in self.roots.values():
            for rel in ('data/backups','backups','.cache','.pnpm-store'):
                args+=['--exclude',str(root/rel)]
        for db in dbs:
            for suffix in ('','-wal','-shm','-journal'):
                args+=['--exclude',str(Path(db['source_root'])/db['path'])+suffix]
        args += [str(root) for root in self.roots.values()]+[str(self.state/'current')]
        output=self.restic(args)
        summary=next(json.loads(l) for l in reversed(output.splitlines()) if json.loads(l).get('message_type')=='summary')
        sid=summary['snapshot_id']
        self.restic(['tag','--set','routine,'+batch,sid])
        snapshots=json.loads(self.restic(['snapshots','--json','--host',self.host,'--tag','routine,'+batch]))
        if len(snapshots)!=1: raise RuntimeError('completed snapshot lookup failed')
        sid=snapshots[0]['id']
        # Publish success before retention; failed backups never expire the last good copy.
        report={'snapshot_id':sid,'started_at':started,'finished_at':time.time(),'seconds':round(time.time()-started,2),
                'databases':len(dbs),'data_added':summary.get('data_added'),'total_bytes_processed':summary.get('total_bytes_processed')}
        save(self.state/'last-backup.json',report)
        self.restic(['forget','--host',self.host,'--tag','routine','--group-by','host','--keep-last',str(self.keep)])
        self.restic(['forget','--host',self.host,'--tag','routine-pending','--group-by','host','--keep-last','1'])
        return report

    def drill(self, sid=None):
        last=json.loads((self.state/'last-backup.json').read_text())
        sid=sid or last['snapshot_id']
        if not re.fullmatch('[a-f0-9]{8,64}',sid): raise ValueError('explicit snapshot ID required')
        started=time.time()
        # Only restore the SQLite images and manifest, never execute restored scripts/credentials.
        with tempfile.TemporaryDirectory(prefix='drill-',dir=self.state) as tmp:
            root=Path(tmp)
            self.restic(['restore',sid,'--target',tmp,'--include',str(self.state/'current'),'--verify'])
            current=root/str(self.state/'current').lstrip('/')
            m=json.loads((current/'manifest.json').read_text())
            for db in m['databases']:
                rel=Path(db['path'])
                if rel.is_absolute() or '..' in rel.parts: raise RuntimeError('unsafe database path')
                p=current/db.get('image_path',str(Path('sqlite')/rel))
                if not regular(p) or not p.resolve().is_relative_to(current.resolve()) or digest(p)!=db['sha256']: raise RuntimeError('restored database hash mismatch')
                with contextlib.closing(sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)) as c:
                    if c.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]: raise RuntimeError('restored database corrupt')
            report={'snapshot_id':sid,'finished_at':time.time(),'seconds':round(time.time()-started,2),'databases':len(m['databases']),
                    'scope':'SQLite restore/hash/integrity only; no application started'}
            save(self.state/'last-drill.json',report)
            return report

    def restore_copy(self, sid, target):
        if not sid or not re.fullmatch('[a-f0-9]{8,64}',sid): raise ValueError('explicit snapshot ID required')
        target=Path(target)
        if not target.is_absolute() or target.exists(): raise ValueError('restore target must be a new absolute directory')
        parent=target.parent.resolve(strict=True)
        for protected in (*self.roots.values(),self.state):
            if parent==protected or protected in parent.parents: raise ValueError('restore target must be outside production/state')
        self.restic(['restore',sid,'--target',str(target),'--verify'])
        current=target/str(self.state/'current').lstrip('/')
        manifest=json.loads((current/'manifest.json').read_text())
        for db in manifest['databases']:
            rel=Path(db['path'])
            if rel.is_absolute() or '..' in rel.parts: raise RuntimeError('unsafe database path')
            source=current/db.get('image_path',str(Path('sqlite')/rel))
            source_root=Path(db.get('source_root',manifest['base']))
            if not source_root.is_absolute() or '..' in source_root.parts or source_root==Path('/'):
                raise RuntimeError('unsafe source root')
            dest=target/str(source_root).lstrip('/')/rel
            if not source.resolve().is_relative_to(target.resolve()) or not dest.resolve().is_relative_to(target.resolve()):
                raise RuntimeError('restore symlink escapes destination')
            if not regular(source) or digest(source)!=db['sha256']: raise RuntimeError('database hash mismatch')
            with contextlib.closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as c:
                if c.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]: raise RuntimeError('database integrity failure')
            dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(source,dest)
            # Staging images belong to the backup identity, not the database owner.
            if 'uid' in db and 'gid' in db and os.geteuid()==0:
                os.chown(dest,db['uid'],db['gid'])
            os.chmod(dest,db.get('mode',0o600))
        report={'snapshot_id':sid,'restored_at':time.time(),'databases':len(manifest['databases']),'safe_to_start':False,
                'next':'Configure isolated paths/credentials/network first; this is an online per-database snapshot, not a cutover freeze.'}
        save(target/'restore-report.json',report)
        return report

    def archive_release(self, path, apply=False):
        parent=Path(self.cfg.get('upgrade_root',str(self.base.parent/'dsh-upgrades'))).resolve(strict=True)
        source=Path(path)
        if source.is_symlink() or source.resolve().parent!=parent or not re.fullmatch(r'20[0-9]{6}-[a-zA-Z0-9_-]+',source.name):
            raise ValueError('only named direct children of the upgrade root can be retired')
        source=source.resolve(strict=True)
        releases=sorted(p for p in parent.iterdir() if p.is_dir() and not p.is_symlink() and re.fullmatch(r'20[0-9]{6}-[a-zA-Z0-9_-]+',p.name))
        if source==releases[-1]: raise RuntimeError('latest release workspace is pinned locally')
        def check_idle():
            for p in source.glob('dsh-freeze-*/state.json'):
                d=json.loads(p.read_text())
                if d.get('hold') and not d.get('resumed_at'): raise RuntimeError('release has a held freeze')
            # Retire only offline workspaces, never live links, cwd, descriptors or mounts.
            for line in Path('/proc/self/mountinfo').read_text().splitlines():
                target=Path(line.split()[4])
                if target==source or source in target.parents: raise RuntimeError('workspace still mounted')
            for parent_dir, dirs, files in os.walk(self.base,followlinks=False):
                for name in dirs+files:
                    p=Path(parent_dir)/name
                    if p.is_symlink() and (p.resolve()==source or source in p.resolve().parents): raise RuntimeError('live application references release')
            for proc in Path('/proc').iterdir():
                if not proc.name.isdigit():continue
                for p in [proc/'cwd',proc/'exe',*list((proc/'fd').glob('*'))]:
                    try: target=p.resolve(strict=True)
                    except FileNotFoundError:continue
                    if target==source or source in target.parents:raise RuntimeError('process references release')
        def inventory():
            h=hashlib.sha256()
            for parent_dir,dirs,files in os.walk(source,followlinks=False):
                dirs.sort()
                for name in sorted(dirs+files):
                    p=Path(parent_dir)/name; st=p.lstat()
                    h.update(repr((str(p.relative_to(source)),st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)).encode())
            return h.hexdigest()
        check_idle()
        before=inventory()
        batch='archive-'+uuid.uuid4().hex
        output=self.restic(['backup','--json','--host',self.host,'--tag',batch,str(source)])
        summary=next(json.loads(l) for l in reversed(output.splitlines()) if json.loads(l).get('message_type')=='summary')
        sid=summary['snapshot_id']
        # Full cryptographic read of repository data before retiring the local workspace.
        self.restic(['check','--read-data'])
        self.restic(['tag','--set','release-archive,'+batch,sid])
        snapshots=json.loads(self.restic(['snapshots','--json','--host',self.host,'--tag','release-archive,'+batch]))
        if len(snapshots)!=1:raise RuntimeError('archive snapshot lookup failed')
        sid=snapshots[0]['id']
        report={'path':str(source),'snapshot_id':sid,'verified_at':time.time(),'removed':False,
                'logical_bytes':summary.get('total_bytes_processed'),'data_added':summary.get('data_added')}
        save(self.state/('release-'+source.name+'.json'),report)
        if apply:
            check_idle()
            if inventory()!=before: raise RuntimeError('release changed during archival; kept locally')
            shutil.rmtree(source)
            report['removed']=True
            save(self.state/('release-'+source.name+'.json'),report)
        self.restic(['forget','--host',self.host,'--tag','release-archive','--group-by','host','--keep-last','3'])
        return report

    def cleanup(self, apply=False):
        # Intentionally exclude results/flows/evidence/sessions and all upgrade recovery points.
        candidates=[]
        journals=[self.base/'data/audit.jsonl',*(self.base/'data/events').glob('*.jsonl')]
        if any(not p.resolve().is_relative_to(self.base) for p in journals):
            raise RuntimeError('log path escapes application')
        rotations=[]
        for log in journals:
            if regular(log) and log.stat().st_size>50*1024**2:
                rotations.append(str(log))
                if apply: log.rename(log.with_name(log.name+'.'+str(time.time_ns())+'.bak'))
        backups=self.base/'data/backups'
        if backups.is_dir() and not backups.is_symlink():
            files=sorted([p for p in backups.glob('asset-graph.*.db') if regular(p)],key=lambda p:p.stat().st_mtime,reverse=True)
            # Verify the retained copies before removing any older copy.
            if len(files)>2:
                for p in files[:2]:
                    with contextlib.closing(sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)) as c:
                        if c.execute('PRAGMA quick_check').fetchall()!=[('ok',)]: raise RuntimeError('retained local backup is corrupt')
                candidates+=files[2:]
        for log in journals:
            logs=sorted([p for p in log.parent.glob(log.name+'.*.bak') if regular(p)],key=lambda p:p.stat().st_mtime,reverse=True)
            candidates += logs[3:]
        report={'apply':apply,'rotations':rotations,'files':[str(p) for p in candidates],'bytes':sum(p.stat().st_size for p in candidates)}
        if apply:
            for p in candidates: p.unlink()
        return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',default='/etc/silksec-maintenance.json')
    p.add_argument('action',choices=['status','init','backup','check','prune','drill','cleanup','archive-release','restore-copy'])
    p.add_argument('--target');p.add_argument('--path');p.add_argument('--snapshot');p.add_argument('--apply',action='store_true')
    a=p.parse_args()
    os.umask(0o077)
    m=Maintenance(json.loads(Path(a.config).read_text()))
    with (contextlib.nullcontext() if a.action=='status' else m.lock()):
        if a.action=='status':
            result=m.status()
        elif a.action=='init': result={'output':m.restic(['init'])}
        elif a.action=='backup':result=m.backup()
        elif a.action=='drill':result=m.drill(a.snapshot)
        elif a.action=='restore-copy':
            if not a.target:raise ValueError('--target required')
            result=m.restore_copy(a.snapshot,a.target)
        elif a.action=='cleanup':result=m.cleanup(a.apply)
        elif a.action=='archive-release':
            if not a.path: raise ValueError('--path required')
            result=m.archive_release(a.path,a.apply)
        elif a.action=='check':
            m.restic(['check','--read-data-subset=5%'])
            result={'finished_at':time.time(),'read_data_subset':'5%'};save(m.state/'last-check.json',result)
        elif a.action=='prune':result={'output':m.restic(['prune','--max-repack-size','2G'])}
        print(json.dumps(result,ensure_ascii=False))
        if a.action=='status' and (result['disk']['level']!='ok' or result['backup_stale'] or not result['nas_ready']):return 2
    return 0

if __name__=='__main__':
    try: raise SystemExit(main())
    except BlockingIOError:
        print(json.dumps({'skipped':'another maintenance operation is running'}));raise SystemExit(75)
    except (OSError,RuntimeError,ValueError,subprocess.SubprocessError) as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False));raise SystemExit(1)
