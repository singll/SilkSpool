const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { publish } = require('./publish.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-publish-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { sourceRoot: path.join(root, 'source'), vaultRoot: path.join(root, 'vault'), targetPrefix: '20-PKB/Bellkeeper', stateRoot: path.join(root, 'state'), settleMs: 0 };
  for (const directory of [options.sourceRoot, options.vaultRoot, options.stateRoot]) await fs.mkdir(directory);
  const source = path.join(options.sourceRoot, '笔记.md');
  const target = path.join(options.vaultRoot, options.targetPrefix, '笔记.md');
  return { root, options, source, target };
}

test('publishes new and changed notes, is idempotent, and retains NAS source', async t => {
  const { options, source, target } = await fixture(t);
  await fs.writeFile(source, '初版');
  assert.equal((await publish({ ...options, dryRun: true })).created, 1);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.equal((await publish(options)).created, 1);
  assert.equal(await fs.readFile(target, 'utf8'), '初版');
  assert.equal((await publish(options)).unchanged, 1);
  await fs.writeFile(source, '新版');
  assert.equal((await publish(options)).updated, 1);
  assert.equal(await fs.readFile(target, 'utf8'), '新版');
  assert.equal(await fs.readFile(source, 'utf8'), '新版');
});

test('terminal edits and deletions win; source deletions never delete Vault notes', async t => {
  const { options, source, target } = await fixture(t);
  await fs.writeFile(source, '初版'); await publish(options);
  await fs.writeFile(target, '人工修改'); await fs.writeFile(source, '机器更新');
  assert.equal((await publish(options)).conflicts[0].reason, 'destination-edited');
  assert.equal(await fs.readFile(target, 'utf8'), '人工修改');
  await fs.unlink(target);
  assert.equal((await publish(options)).conflicts[0].reason, 'destination-deleted');
  await fs.writeFile(target, '人工恢复'); await fs.unlink(source);
  assert.deepEqual((await publish(options)).sourceMissing, ['笔记.md']);
  assert.equal(await fs.readFile(target, 'utf8'), '人工恢复');
});

test('untracked existing notes are not overwritten, identical notes can be adopted', async t => {
  const { options, source, target } = await fixture(t);
  await fs.writeFile(source, '机器'); await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '已有笔记');
  assert.equal((await publish(options)).conflicts[0].reason, 'destination-edited');
  await fs.writeFile(target, '机器');
  assert.equal((await publish(options)).adopted, 1);
  await fs.writeFile(source, '机器更新');
  assert.equal((await publish(options)).updated, 1);
});

test('rejects unsafe paths, symlink destination parents, and Unicode/case collisions', async t => {
  const { root, options, source } = await fixture(t);
  await assert.rejects(publish({ ...options, targetPrefix: '../outside' }), /Invalid/);
  await fs.writeFile(source, 'body');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(options.vaultRoot, '20-PKB'));
  await assert.rejects(publish(options), /Unsafe/);
  await fs.unlink(path.join(options.vaultRoot, '20-PKB'));
  await fs.writeFile(path.join(options.sourceRoot, 'Name.md'), 'a');
  await fs.writeFile(path.join(options.sourceRoot, 'name.md'), 'b');
  const report = await publish(options);
  assert.equal(report.conflicts.filter(v => v.reason === 'case-or-unicode-collision').length, 2);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('ignores hidden files, non-Markdown, and symbolic links; defers active writes', async t => {
  const { options, source } = await fixture(t);
  await fs.writeFile(source, 'note');
  await fs.writeFile(path.join(options.sourceRoot, '.private.md'), 'secret');
  await fs.writeFile(path.join(options.sourceRoot, 'movie.mp4'), 'media');
  await fs.symlink(source, path.join(options.sourceRoot, 'link.md'));
  const report = await publish({ ...options, settleMs: 60000 });
  assert.equal(report.source, 1); assert.equal(report.deferred, 1); assert.equal(report.created, 0);
});


test('rejects a symlink nested within the publication directory before reading a target', async t => {
  const { root, options } = await fixture(t);
  await fs.mkdir(path.join(options.sourceRoot, 'AI'));
  await fs.writeFile(path.join(options.sourceRoot, 'AI/note.md'), 'safe');
  await fs.mkdir(path.join(options.vaultRoot, options.targetPrefix), { recursive: true });
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'note.md'), 'private');
  await fs.symlink(outside, path.join(options.vaultRoot, options.targetPrefix, 'AI'));
  await assert.rejects(publish(options), /Unsafe directory/);
  await assert.rejects(publish({ ...options, dryRun: true }), /Unsafe directory/);
  assert.equal(await fs.readFile(path.join(outside, 'note.md'), 'utf8'), 'private');
});
