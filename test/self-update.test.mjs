import assert from 'node:assert/strict';
import test from 'node:test';
import { SelfUpdate } from '../src/self-update.mjs';

const root = new URL('..', import.meta.url).pathname;

test('check reports the current commit and whether an update is safe', async () => {
  const update = new SelfUpdate({ root, logger: { warn() {} } });
  const result = await update.check();
  assert.equal(result.ok, true);
  assert.equal(typeof result.current, 'string');
  assert.equal(result.current.length, 40);
  assert.equal(typeof result.canUpdate, 'boolean');
});

test('an edit to a tracked file makes the update unsafe and apply refuses', async () => {
  const { writeFileSync, readFileSync, unlinkSync } = await import('node:fs');
  // The script ignores untracked files on purpose (they rarely block a
  // fast-forward), so the conflict must be an edit to a tracked file.
  const tracked = `${root}src/.self-update-tracked`;
  writeFileSync(tracked, 'original\n');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['add', '-f', tracked], { cwd: root });
  try {
    writeFileSync(tracked, 'edited\n');
    const update = new SelfUpdate({ root, logger: { warn() {} } });
    const check = await update.check();
    assert.equal(check.canUpdate, false, 'a local change must block updating');
    assert.match(String(check.blockedReason), /local changes/i);
    const applied = await update.apply();
    assert.equal(applied.ok, false);
    assert.match(String(applied.reason), /local changes/i);
    assert.equal(update.restartRequired, false);
  } finally {
    execFileSync('git', ['reset', '--quiet', tracked], { cwd: root });
    unlinkSync(tracked);
  }
});
