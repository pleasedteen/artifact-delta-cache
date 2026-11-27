import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { Cache } from '../cache.js';
import {
  makeTempDir,
  runWorker,
  sleep,
  startWorker,
  waitForExit,
  waitForWorkerMessage,
} from './helpers.js';

const MiB = 1024 * 1024;
const KiB = 1024;

function digest(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function openCache(root: string, quotaBytes = 9 * MiB): Promise<{ root: string; dir: string; cache: Cache }> {
  const dir = path.join(root, 'cache');
  const cache = await Cache.open({ dir, quotaBytes });
  return { root, dir, cache };
}

test('put, digest-verified restore, withdrawal, and occupancy', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { dir, cache } = await openCache(root, MiB);

  const data = crypto.randomBytes(100 * KiB);
  const result = await cache.put('artifact-a', data, { expectedDigest: digest(data) });
  assert.equal(result.size, 100 * KiB);

  let stats = await cache.stats();
  assert.equal(stats.keyCount, 1);
  assert.equal(stats.occupiedBytes, 100 * KiB);

  const output = path.join(root, 'restored-a.bin');
  const restored = await cache.restore('artifact-a', output);
  assert.equal(restored.digest, digest(data));
  assert.deepEqual(await fs.readFile(output), data);

  stats = await cache.stats();
  assert.ok(stats.keys[0]!.lastRestoredAt);

  assert.equal(await cache.remove('artifact-a'), true);
  assert.equal(await cache.has('artifact-a'), false);
  stats = await cache.stats();
  assert.equal(stats.keyCount, 0);
  assert.equal(stats.occupiedBytes, 0);

  // The caller-owned output is outside the cache and must not be reclaimed/counted.
  assert.deepEqual(await fs.readFile(output), data);
  assert.equal(dir.endsWith('cache'), true);
});

test('9 MiB quota shares an 8 MiB base across 12 chain-derived generations', { timeout: 60_000 }, async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cache } = await openCache(root, 9 * MiB);

  const base = crypto.randomBytes(8 * MiB);
  await cache.put('base', base);

  // Choose any offset, including aligned and boundary positions on different runs.
  const overwriteOffset = crypto.randomInt(0, base.length - 64 * KiB + 1);
  t.diagnostic(`9 MiB scenario overwriteOffset=${overwriteOffset}`);
  let parentKey = 'base';
  let lastExpected: Buffer | undefined;

  for (let generation = 0; generation < 12; generation += 1) {
    const patch = crypto.randomBytes(64 * KiB);
    const expected = Buffer.from(base);
    patch.copy(expected, overwriteOffset);
    lastExpected = expected;

    const newKey = `generation-${generation}`;
    const result = await cache.derive(newKey, {
      baseKey: parentKey,
      ranges: [{ offset: overwriteOffset, data: patch }],
      expectedDigest: digest(expected),
    });
    assert.equal(result.size, base.length);
    parentKey = newKey;
  }

  let stats = await cache.stats();
  assert.equal(stats.keyCount, 13);
  assert.equal(stats.occupiedBytes, 8 * MiB + 12 * 64 * KiB);
  assert.ok(stats.occupiedBytes <= 9 * MiB);

  // Every generation is independently restorable and digest-verified.
  for (let generation = 0; generation < 12; generation += 1) {
    const output = path.join(root, `gen-${generation}.bin`);
    await cache.restore(`generation-${generation}`, output);
  }

  await cache.remove('base');
  for (let generation = 0; generation < 11; generation += 1) {
    await cache.remove(`generation-${generation}`);
  }

  stats = await cache.stats();
  assert.equal(stats.keyCount, 1);
  assert.equal(stats.occupiedBytes, 8 * MiB + 64 * KiB);

  const other = crypto.randomBytes(768 * KiB);
  await cache.put('other-768k', other);

  stats = await cache.stats();
  assert.equal(stats.keyCount, 2);
  assert.equal(stats.occupiedBytes, 8 * MiB + 64 * KiB + 768 * KiB);
  assert.ok(stats.occupiedBytes <= 9 * MiB);

  const lastOutput = path.join(root, 'last.bin');
  await cache.restore('generation-11', lastOutput);
  assert.deepEqual(await fs.readFile(lastOutput), lastExpected);

  const otherOutput = path.join(root, 'other.bin');
  await cache.restore('other-768k', otherOutput);
  assert.deepEqual(await fs.readFile(otherOutput), other);
});

test('withdrawn base is immediately absent while published derived artifact restores', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { dir, cache } = await openCache(root, MiB);

  const base = crypto.randomBytes(256 * KiB);
  const patch = crypto.randomBytes(32 * KiB);
  const offset = 12_345;
  const expected = Buffer.from(base);
  patch.copy(expected, offset);

  await cache.put('base-key', base);
  await cache.derive('child-key', {
    baseKey: 'base-key',
    ranges: [{ offset, data: patch }],
    expectedDigest: digest(expected),
  });

  await cache.remove('base-key');
  assert.equal(await cache.has('base-key'), false);

  const output = path.join(root, 'child.bin');
  await cache.restore('child-key', output);
  assert.deepEqual(await fs.readFile(output), expected);

  // Reopening preserves confirmed metadata and shared data.
  const reopened = await Cache.open({ dir, quotaBytes: MiB });
  const output2 = path.join(root, 'child2.bin');
  await reopened.restore('child-key', output2);
  assert.deepEqual(await fs.readFile(output2), expected);
});

test('failed derivation digest check does not publish or alter existing occupancy', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cache } = await openCache(root, MiB);

  const base = crypto.randomBytes(128 * KiB);
  await cache.put('base', base);
  const patch = crypto.randomBytes(16 * KiB);

  await assert.rejects(
    cache.derive('bad-child', {
      baseKey: 'base',
      ranges: [{ offset: 100, data: patch }],
      expectedDigest: '0'.repeat(64),
    }),
    (error: Error & { code?: string }) => error.code === 'DIGEST_MISMATCH',
  );

  assert.equal(await cache.has('bad-child'), false);
  const stats = await cache.stats();
  assert.equal(stats.keyCount, 1);
  assert.equal(stats.occupiedBytes, 128 * KiB);
});

test('corrupt restored bytes fail digest verification and no final output is delivered', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cache } = await openCache(root, MiB);

  const data = crypto.randomBytes(256 * KiB);
  await cache.put('corrupt-me', data);
  const stats = await cache.stats();
  const record = stats.keys.find((key) => key.key === 'corrupt-me')!;
  const blobPath = cache.blobPath(record.digest);

  const handle = await fs.open(blobPath, 'r+');
  try {
    const one = Buffer.alloc(1);
    await handle.read(one, 0, 1, 4096);
    one[0] = one[0]! ^ 0xff;
    await handle.write(one, 0, 1, 4096);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const output = path.join(root, 'should-not-exist.bin');
  await assert.rejects(
    cache.restore('corrupt-me', output),
    (error: Error & { code?: string }) => error.code === 'DIGEST_MISMATCH',
  );
  await assert.rejects(fs.access(output), { code: 'ENOENT' });

  const files = await fs.readdir(root);
  assert.equal(files.some((name) => name.includes('.restore-')), false);
});

test('evicts coldest keys only until quota is met, using restore time', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let clock = 1_000_000;
  const dir = path.join(root, 'cache');
  const cache = await Cache.open({ dir, quotaBytes: 500 * KiB, now: () => clock });

  clock = 1_000;
  await cache.put('a-oldest', crypto.randomBytes(128 * KiB));
  clock = 2_000;
  await cache.put('b-cold', crypto.randomBytes(128 * KiB));
  clock = 3_000;
  await cache.put('c-new', crypto.randomBytes(128 * KiB));

  clock = 4_000;
  await cache.read('a-oldest'); // successful restore makes A hot.

  clock = 5_000;
  const result = await cache.put('d-trigger', crypto.randomBytes(128 * KiB));
  assert.deepEqual(result.evictedKeys, ['b-cold']);

  const stats = await cache.stats();
  assert.equal(stats.occupiedBytes, 3 * 128 * KiB);
  assert.equal(await cache.has('b-cold'), false);
  assert.equal(await cache.has('a-oldest'), true);
  assert.equal(await cache.has('c-new'), true);
  assert.equal(await cache.has('d-trigger'), true);
});

test('rejects an impossible oversized write without changing existing keys', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cache } = await openCache(root, 256 * KiB);

  await cache.put('keep-a', crypto.randomBytes(100 * KiB));
  await cache.put('keep-b', crypto.randomBytes(100 * KiB));

  await assert.rejects(
    cache.put('too-big', crypto.randomBytes(300 * KiB)),
    (error: Error & { code?: string }) => error.code === 'QUOTA_EXCEEDED',
  );

  const stats = await cache.stats();
  assert.equal(stats.keyCount, 2);
  assert.equal(stats.occupiedBytes, 200 * KiB);
  assert.equal(await cache.has('keep-a'), true);
  assert.equal(await cache.has('keep-b'), true);
  assert.equal(await cache.has('too-big'), false);
});

test('derivation supports several unaligned ranges and verifies the whole result', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cache } = await openCache(root, MiB);

  const base = crypto.randomBytes(128 * KiB);
  await cache.put('base', base);

  const patches = [
    { offset: 17, data: crypto.randomBytes(4096) },
    { offset: 70_003, data: crypto.randomBytes(8192) },
  ];
  const expected = Buffer.from(base);
  for (const patch of patches) patch.data.copy(expected, patch.offset);

  await cache.derive('multi', {
    baseKey: 'base',
    ranges: patches,
    expectedDigest: digest(expected),
  });

  assert.deepEqual(await cache.read('multi'), expected);
});

test('empty artifacts roundtrip and occupy zero data bytes', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cache } = await openCache(root, MiB);

  await cache.put('empty', Buffer.alloc(0));
  const stats = await cache.stats();
  assert.equal(stats.occupiedBytes, 0);
  assert.equal((await cache.read('empty')).length, 0);
});

test('identical shared copies occupy one content-addressed blob', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cache } = await openCache(root, MiB);

  const data = crypto.randomBytes(64 * KiB);
  await cache.put('shared-a', data);
  await cache.put('shared-b', data);

  const stats = await cache.stats();
  assert.equal(stats.keyCount, 2);
  assert.equal(stats.occupiedBytes, 64 * KiB);
  assert.deepEqual(await cache.read('shared-a'), data);
  assert.deepEqual(await cache.read('shared-b'), data);
});

test('pinned in-flight bytes can make a write impossible without changing existing keys', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cache } = await openCache(root, 512 * KiB);

  await cache.put('pinned', crypto.randomBytes(256 * KiB));
  await cache.put('keep', crypto.randomBytes(128 * KiB));
  const lease = await cache.openRead('pinned');
  t.after(() => lease.release().catch(() => undefined));

  await cache.remove('pinned');
  assert.equal(await cache.has('pinned'), false);

  let stats = await cache.stats();
  assert.equal(stats.occupiedBytes, 384 * KiB);

  await assert.rejects(
    cache.put('blocked', crypto.randomBytes(384 * KiB)),
    (error: Error & { code?: string }) => error.code === 'QUOTA_EXCEEDED',
  );

  assert.equal(await cache.has('keep'), true);
  assert.equal(await cache.has('blocked'), false);
  stats = await cache.stats();
  assert.equal(stats.keyCount, 1);
  assert.equal(stats.occupiedBytes, 384 * KiB);
});

test('SIGSTOP reader keeps selected derived snapshot through withdrawal and reclamation', { timeout: 60_000 }, async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const quota = 2 * MiB;
  const { dir, cache } = await openCache(root, quota);

  const base = crypto.randomBytes(256 * KiB);
  const patch = crypto.randomBytes(64 * KiB);
  const offset = 54_321;
  const expected = Buffer.from(base);
  patch.copy(expected, offset);

  await cache.put('base', base);
  await cache.derive('selected-child', {
    baseKey: 'base',
    ranges: [{ offset, data: patch }],
    expectedDigest: digest(expected),
  });

  const outputPath = path.join(root, 'paused-reader-output.bin');
  const reader = startWorker({
    cmd: 'hold-reader',
    dir,
    key: 'selected-child',
    outputPath,
    quotaBytes: quota,
  });

  await waitForWorkerMessage(reader, 'ready');
  reader.kill('SIGSTOP');
  await sleep(300);

  // Independent short-lived processes perform withdrawal and GC while stopped.
  const removedBase = await runWorker({ cmd: 'remove', dir, key: 'base', quotaBytes: quota });
  assert.equal(removedBase.existed, true);
  const removedChild = await runWorker({ cmd: 'remove', dir, key: 'selected-child', quotaBytes: quota });
  assert.equal(removedChild.existed, true);
  assert.equal(Number(removedChild.occupiedBytes), 256 * KiB + 64 * KiB);

  assert.equal(await cache.has('base'), false);
  assert.equal(await cache.has('selected-child'), false);

  reader.kill('SIGCONT');
  reader.send({ type: 'continue' });
  const done = await waitForWorkerMessage(reader, 'done', 30_000);
  assert.equal(done.digest, digest(expected));
  await waitForExit(reader);

  assert.deepEqual(await fs.readFile(outputPath), expected);
});

test('SIGKILL reader lease is reclaimed by next open', { timeout: 45_000 }, async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { dir, cache } = await openCache(root, MiB);

  await cache.put('lease-key', crypto.randomBytes(128 * KiB));
  const outputPath = path.join(root, 'dead-reader-output.bin');
  const reader = startWorker({ cmd: 'hold-reader', dir, key: 'lease-key', outputPath, quotaBytes: MiB });
  await waitForWorkerMessage(reader, 'ready');

  const removed = await runWorker({ cmd: 'remove', dir, key: 'lease-key', quotaBytes: MiB });
  assert.equal(Number(removed.occupiedBytes), 128 * KiB);

  reader.kill('SIGKILL');
  await waitForExit(reader);

  // Before another open, the dead reader's hard-linked inode is still retained.
  let stats = await cache.stats();
  assert.equal(stats.occupiedBytes, 128 * KiB);

  const reopened = await Cache.open({ dir, quotaBytes: MiB });
  stats = await reopened.stats();
  assert.equal(stats.occupiedBytes, 0);
});

test('SIGKILL writer lock and over-quota leftover are recovered on next open', { timeout: 45_000 }, async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const quota = MiB;
  const { dir, cache } = await openCache(root, quota);

  const persistent = crypto.randomBytes(256 * KiB);
  await cache.put('persistent', persistent);

  const leftoverBytes = 800 * KiB;
  const writer = startWorker({ cmd: 'crash-writer', dir, bytes: leftoverBytes, quotaBytes: quota });
  await waitForWorkerMessage(writer, 'ready');
  writer.kill('SIGKILL');
  await waitForExit(writer);

  const unrecovered = await Cache.open({ dir, quotaBytes: quota, recover: false });
  const before = await unrecovered.stats();
  assert.equal(before.occupiedBytes, 256 * KiB + leftoverBytes);
  assert.ok(before.occupiedBytes > quota);

  const recovered = await Cache.open({ dir, quotaBytes: quota });
  const after = await recovered.stats();
  assert.equal(after.occupiedBytes, 256 * KiB);
  assert.ok(after.occupiedBytes <= quota);
  assert.deepEqual(await recovered.read('persistent'), persistent);
});

test('next open evicts cold confirmed keys when durable state is over the configured quota', async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'cache');

  const first = await Cache.open({ dir, quotaBytes: 2 * MiB });
  await first.put('old-cold', crypto.randomBytes(512 * KiB));
  await sleep(5);
  await first.put('new-warm', crypto.randomBytes(512 * KiB));
  await first.close();

  const reopened = await Cache.open({ dir, quotaBytes: 768 * KiB });
  const stats = await reopened.stats();
  assert.ok(stats.occupiedBytes <= 768 * KiB);
  assert.equal(await reopened.has('old-cold'), false);
  assert.equal(await reopened.has('new-warm'), true);
});

test('multiple independent processes compete on derives, puts, and restores', { timeout: 75_000 }, async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const quota = 64 * MiB;
  const { dir, cache } = await openCache(root, quota);

  const base = crypto.randomBytes(256 * KiB);
  const basePath = path.join(root, 'stress-base.bin');
  await fs.writeFile(basePath, base);
  await cache.put('stress-base', base);

  const workerCount = 6;
  const iterations = 8;
  const children = Array.from({ length: workerCount }, (_, workerId) =>
    startWorker({
      cmd: 'stress',
      dir,
      workerId,
      iterations,
      basePath,
      quotaBytes: quota,
    }),
  );

  const messages = await Promise.all(
    children.map((child) => waitForWorkerMessage(child, 'done', 60_000)),
  );
  assert.equal(messages.length, workerCount);
  await Promise.all(children.map((child) => waitForExit(child)));

  await cache.gc();
  const stats = await cache.stats();
  assert.ok(stats.occupiedBytes <= quota);
  assert.ok(stats.keyCount > workerCount * iterations);

  // Every currently published key must reconstruct and pass whole-digest checks.
  for (const key of stats.keys) {
    const buffer = await cache.read(key.key);
    assert.equal(buffer.length, key.size);
  }
});

test('parallel processes cannot leave committed occupancy over quota', { timeout: 75_000 }, async (t) => {
  const root = await makeTempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const quota = MiB;
  const { dir } = await openCache(root, quota);

  const workerCount = 6;
  const children = Array.from({ length: workerCount }, (_, workerId) =>
    startWorker({
      cmd: 'quota-race',
      dir,
      workerId,
      count: 6,
      size: 128 * KiB,
      quotaBytes: quota,
    }),
  );

  await Promise.all(children.map((child) => waitForWorkerMessage(child, 'done', 60_000)));
  await Promise.all(children.map((child) => waitForExit(child)));

  const reopened = await Cache.open({ dir, quotaBytes: quota });
  const stats = await reopened.stats();
  assert.ok(
    stats.occupiedBytes <= quota,
    `occupied ${stats.occupiedBytes} > quota ${quota}`,
  );

  for (const key of stats.keys) {
    const data = await reopened.read(key.key);
    assert.equal(digest(data), key.digest);
  }
});
