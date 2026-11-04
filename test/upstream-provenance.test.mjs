import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('runtime bundle matches its pinned official provenance', async () => {
  const lock = JSON.parse(await readFile(new URL('upstream.lock.json', root)));
  const provenance = JSON.parse(await readFile(new URL(lock.runtime.provenance, root)));
  assert.equal(provenance.revision, lock.runtime.commit);
  assert.equal(provenance.bundle.path, lock.runtime.bundle);
  assert.equal(sha256(await readFile(new URL(provenance.bundle.path, root))), provenance.bundle.sha256);
  assert.ok(provenance.inputs.some(({ path }) => path.endsWith('/node-runtime.ts')));
  assert.ok(provenance.inputs.some(({ path }) => path.endsWith('/host-runner.ts')));
  assert.ok(provenance.inputs.some(({ path }) => path.endsWith('/port-registry.ts')));
  assert.ok(provenance.dependencyLicenses.length > 0);
  const notices = await readFile(new URL('src/vendor/official-miniapp.NOTICES.md', root), 'utf8');
  for (const item of provenance.dependencyLicenses) assert.ok(notices.includes(`${item.package}@${item.version}`));
});

test('available official source inputs match recorded hashes', async (t) => {
  const official = resolve(process.env.MINIMAX_RUNTIME_DIR ?? new URL('../minimax-code-official', root).pathname);
  try { await readFile(resolve(official, 'package.json')); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('official checkout is not installed'); throw error; }
  const provenance = JSON.parse(await readFile(new URL('src/vendor/official-miniapp.provenance.json', root)));
  for (const input of provenance.inputs.filter(({ path }) => !path.startsWith('node_modules/'))) {
    assert.equal(sha256(await readFile(resolve(official, input.path))), input.sha256, input.path);
  }
});
