// Publish curated Markdown without overwriting edits made by an Obsidian client.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const hash = data => createHash('sha256').update(data).digest('hex');
const identity = name => name.normalize('NFC').toLowerCase();
const missing = err => err.code === 'ENOENT';

async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

async function regularFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
    return stat;
  } catch (err) { if (missing(err)) return null; throw err; }
}

async function directoryTree(root, relative) {
  // Refuse symlink parents; never follow a path out of the publication tree.
  for (const component of ['', ...relative.split('/').filter(Boolean)]) {
    root = path.join(root, component);
    await fs.mkdir(root).catch(err => { if (err.code !== 'EEXIST') throw err; });
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${root}`);
  }
  return root;
}

async function safeExistingParents(root, relative) {
  for (const component of ['', ...relative.split('/').filter(v => v && v !== '.')]) {
    root = path.join(root, component);
    let stat;
    try { stat = await fs.lstat(root); }
    catch (err) { if (missing(err)) return; throw err; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${root}`);
  }
}

async function listMarkdown(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await listMarkdown(root, name));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(name);
  }
  return result.sort();
}

async function publish({ sourceRoot, vaultRoot, targetPrefix, stateRoot, dryRun = false, settleMs = 5000 }) {
  if (!targetPrefix || targetPrefix.split('/').some(v => !v || v === '.' || v === '..') || path.isAbsolute(targetPrefix)) {
    throw new Error('Invalid publication prefix');
  }
  const targetRoot = path.join(vaultRoot, targetPrefix);
  await safeExistingParents(vaultRoot, targetPrefix);
  const sourceStat = await fs.lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Source is not a directory');
  if (!dryRun) await directoryTree(vaultRoot, targetPrefix);
  const manifestPath = path.join(stateRoot, 'publish-manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (err) { if (!missing(err)) throw err; manifest = { version: 1, files: {} }; }
  if (manifest.version !== 1 || !manifest.files) throw new Error('Invalid publication manifest');
  const names = await listMarkdown(sourceRoot);
  const identities = new Map();
  for (const name of names) {
    const key = identity(name);
    identities.set(key, [...(identities.get(key) || []), name]);
  }
  let targetNames = [];
  try { targetNames = await listMarkdown(targetRoot); } catch (err) { if (!missing(err)) throw err; }
  const targetIdentities = new Map();
  for (const name of targetNames) {
    const key = identity(name);
    targetIdentities.set(key, [...(targetIdentities.get(key) || []), name]);
  }
  const report = { at: new Date().toISOString(), source: names.length, created: 0, updated: 0, unchanged: 0, adopted: 0, deferred: 0, conflicts: [], sourceMissing: [] };
  for (const name of names) {
    if (identities.get(identity(name)).length !== 1 || (targetIdentities.get(identity(name)) || []).some(v => v !== name)) {
      report.conflicts.push({ path: name, reason: 'case-or-unicode-collision' }); continue;
    }
    const source = path.join(sourceRoot, name);
    const destination = path.join(targetRoot, name);
    const before = await regularFile(source);
    if (!before || Date.now() - before.mtimeMs < settleMs) { report.deferred++; continue; }
    if (before.size > 10 * 1024 * 1024) { report.conflicts.push({ path: name, reason: 'larger-than-10MiB' }); continue; }
    const body = await fs.readFile(source);
    const after = await regularFile(source);
    if (!after || before.mtimeMs !== after.mtimeMs || before.size !== after.size) { report.deferred++; continue; }
    const sourceHash = hash(body);
    const previous = manifest.files[name];
    await safeExistingParents(targetRoot, path.posix.dirname(name));
    const targetStat = await regularFile(destination);
    const targetHash = targetStat ? hash(await fs.readFile(destination)) : null;
    if (targetHash === sourceHash) {
      if (!previous || previous.sourceHash !== sourceHash) {
        report.adopted++; manifest.files[name] = { sourceHash, publishedHash: sourceHash };
      } else report.unchanged++;
      continue;
    }
    // A destination deleted or edited by a terminal remains owned by the terminal.
    // Changes in the source are retained there, and surfaced for review.
    if (previous && sourceHash === previous.sourceHash) { report.unchanged++; continue; }
    if ((targetHash !== null && (!previous || targetHash !== previous.publishedHash)) || (previous && targetHash === null)) {
      report.conflicts.push({ path: name, reason: targetHash === null ? 'destination-deleted' : 'destination-edited' }); continue;
    }
    const operation = targetStat ? 'updated' : 'created';
    if (!dryRun) {
      await directoryTree(targetRoot, path.posix.dirname(name));
      // Recheck immediately before replacing a previously published version.
      const currentStat = await regularFile(destination);
      const currentHash = currentStat ? hash(await fs.readFile(destination)) : null;
      if (currentHash !== targetHash) { report.conflicts.push({ path: name, reason: 'destination-changed-during-publish' }); continue; }
      const temporary = path.join(path.dirname(destination), `.${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o644);
      try { await handle.writeFile(body); await handle.sync(); }
      finally { await handle.close(); }
      if (targetStat) await fs.rename(temporary, destination);
      else {
        // Hard-link insertion is exclusive; a concurrently created target wins.
        try { await fs.link(temporary, destination); }
        catch (err) { if (err.code !== 'EEXIST') throw err; report.conflicts.push({ path: name, reason: 'destination-created-during-publish' }); continue; }
        finally { await fs.unlink(temporary); }
      }
      manifest.files[name] = { sourceHash, publishedHash: sourceHash };
      // Checkpoint each committed file so a restart never replays an import over a client edit.
      await atomicJSON(manifestPath, manifest);
    }
    report[operation]++;
  }
  const present = new Set(names);
  report.sourceMissing = Object.keys(manifest.files).filter(name => !present.has(name));
  // Source deletions deliberately do not remove notes from the user's Vault.
  if (!dryRun) {
    await atomicJSON(manifestPath, manifest);
    await atomicJSON(path.join(stateRoot, 'publish-status.json'), report);
  }
  return report;
}

module.exports = { publish, atomicJSON };
if (require.main === module) {
  publish({ sourceRoot: process.env.SOURCE_ROOT || '/source/vault', vaultRoot: process.env.VAULT_ROOT || '/vault', targetPrefix: process.env.TARGET_PREFIX || '20-PKB/Bellkeeper', stateRoot: process.env.STATE_ROOT || '/data', dryRun: process.argv.includes('--dry-run') })
    .then(report => console.log(JSON.stringify(report)))
    .catch(err => { console.error(err.message); process.exitCode = 1; });
}
