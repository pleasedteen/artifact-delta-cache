import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeTempDir } from './helpers.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

async function runCli(args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('CLI supports put, derive, restore, stat, and remove', async (t) => {
  const root = await makeTempDir('linkforge-cli-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'cache');

  const base = crypto.randomBytes(32 * 1024);
  const artifactPath = path.join(root, 'base.bin');
  await fs.writeFile(artifactPath, base);

  const put = await runCli(['put', 'base', artifactPath, '--dir', dir, '--quota', '1m']);
  assert.equal(put.ok, undefined); // put result is raw metadata
  assert.equal(put.size, base.length);

  const restoredPath = path.join(root, 'restored.bin');
  const restored = await runCli(['get', 'base', restoredPath, '--dir', dir]);
  assert.equal(restored.ok, true);
  assert.deepEqual(await fs.readFile(restoredPath), base);

  const patch = crypto.randomBytes(4096);
  const offset = 777;
  const expected = Buffer.from(base);
  patch.copy(expected, offset);
  const expectedDigest = crypto.createHash('sha256').update(expected).digest('hex');
  const rangesPath = path.join(root, 'ranges.json');
  await fs.writeFile(
    rangesPath,
    JSON.stringify([{ offset, dataBase64: patch.toString('base64') }]),
  );

  const derived = await runCli([
    'derive',
    'child',
    'base',
    expectedDigest,
    rangesPath,
    '--dir',
    dir,
  ]);
  assert.equal(derived.digest, expectedDigest);

  const derivedOutput = path.join(root, 'child.bin');
  await runCli(['get', 'child', derivedOutput, '--dir', dir]);
  assert.deepEqual(await fs.readFile(derivedOutput), expected);

  const stats = await runCli(['stat', '--dir', dir]);
  assert.equal(stats.ok, true);
  assert.equal(stats.keyCount, 2);

  const removed = await runCli(['rm', 'base', '--dir', dir]);
  assert.equal(removed.existed, true);
});
