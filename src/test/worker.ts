import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Cache, newStagingName, QuotaExceededError, withLock } from '../index.js';

interface WorkerArgs {
  cmd: string;
  dir: string;
  key?: string;
  newKey?: string;
  outputPath?: string;
  bytes?: number;
  workerId?: number;
  iterations?: number;
  basePath?: string;
  quotaBytes?: number;
  size?: number;
  count?: number;
}

const args = JSON.parse(process.argv[2] ?? '{}') as WorkerArgs;

function send(message: Record<string, unknown>): void {
  if (process.send) process.send(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendAndExit(message: Record<string, unknown>): void {
  if (process.send) {
    process.send(message, () => process.exit(0));
  } else {
    process.stdout.write(`${JSON.stringify(message)}\n`, () => process.exit(0));
  }
}

function fail(error: unknown): never {
  const err = error as Error & { code?: string; details?: unknown };
  send({ type: 'error', name: err.name, code: err.code, message: err.message, details: err.details });
  process.exit(1);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

async function holdReader(): Promise<void> {
  if (!args.key || !args.outputPath) throw new Error('hold-reader requires key and outputPath');
  const cache = await Cache.open({ dir: args.dir, quotaBytes: args.quotaBytes });
  const lease = await cache.openRead(args.key);
  send({ type: 'ready', leaseId: lease.id });

  process.on('message', async (message: { type?: string }) => {
    if (message?.type !== 'continue') return;
    try {
      const result = await lease.restoreTo(args.outputPath!);
      await lease.release();
      sendAndExit({ type: 'done', digest: result.digest, size: result.size });
    } catch (error) {
      fail(error);
    }
  });
}

async function removeKey(): Promise<void> {
  if (!args.key) throw new Error('remove requires key');
  const cache = await Cache.open({ dir: args.dir, quotaBytes: args.quotaBytes });
  const existed = await cache.remove(args.key);
  const stats = await cache.stats();
  sendAndExit({ type: 'removed', existed, occupiedBytes: stats.occupiedBytes, keyCount: stats.keyCount });
}

async function crashWriter(): Promise<void> {
  const cache = await Cache.open({ dir: args.dir, quotaBytes: args.quotaBytes });
  const bytes = args.bytes ?? 1024 * 1024 + 777;
  await withLock(cache.dir, async () => {
    const staging = path.join(cache.tmpDir, newStagingName());
    await fs.writeFile(staging, crypto.randomBytes(bytes));
    send({ type: 'ready', staging });
    // Intentionally never release the lock. The test sends SIGKILL.
    await new Promise<void>(() => undefined);
  });
}

async function stress(): Promise<void> {
  const workerId = args.workerId ?? 0;
  const iterations = args.iterations ?? 10;
  const cache = await Cache.open({ dir: args.dir, quotaBytes: args.quotaBytes ?? 64 * 1024 * 1024 });
  const base = args.basePath ? await fs.readFile(args.basePath) : undefined;

  for (let i = 0; i < iterations; i += 1) {
    const putKey = `w${workerId}-put-${i}`;
    const data = crypto.randomBytes(8192 + ((i + workerId) % 9) * 4096);
    await cache.put(putKey, data);
    const restored = await cache.read(putKey);
    if (!restored.equals(data)) throw new Error(`put roundtrip mismatch ${putKey}`);

    if (base) {
      const deriveKey = `w${workerId}-derive-${i}`;
      const patch = crypto.randomBytes(4096);
      const offset = 8192 + ((i * 613 + workerId * 97) % Math.max(1, base.length - 16384));
      const expected = Buffer.from(base);
      patch.copy(expected, offset);
      await cache.derive(deriveKey, {
        baseKey: 'stress-base',
        ranges: [{ offset, data: patch }],
        expectedDigest: crypto.createHash('sha256').update(expected).digest('hex'),
      });
      const derived = await cache.read(deriveKey);
      if (!derived.equals(expected)) throw new Error(`derive roundtrip mismatch ${deriveKey}`);
    }

    if (i > 2 && i % 3 === 0) {
      await cache.remove(`w${workerId}-put-${i - 2}`);
    }
  }

  sendAndExit({ type: 'done', workerId, iterations });
}

async function quotaRace(): Promise<void> {
  const workerId = args.workerId ?? 0;
  const count = args.count ?? 6;
  const size = args.size ?? 128 * 1024;
  const cache = await Cache.open({ dir: args.dir, quotaBytes: args.quotaBytes ?? 1024 * 1024 });

  for (let i = 0; i < count; i += 1) {
    const key = `q-${workerId}-${i}`;
    try {
      await cache.put(key, crypto.randomBytes(size));
      try {
        const back = await cache.read(key);
        if (back.length !== size) throw new Error('bad quota race read length');
      } catch (readError) {
        // A competing process may legally evict this brand-new key before the
        // immediate read under a very small shared quota.
        if ((readError as { code?: string }).code !== 'NOT_FOUND') throw readError;
      }
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        // All writes here are smaller than quota, so eviction should make room.
        throw new Error(`unexpected quota rejection for ${key}: ${(error as Error).message}`);
      }
      throw error;
    }
  }
  sendAndExit({ type: 'done', workerId, count });
}

async function main(): Promise<void> {
  switch (args.cmd) {
    case 'hold-reader':
      await holdReader();
      break;
    case 'remove':
      await removeKey();
      break;
    case 'crash-writer':
      await crashWriter();
      break;
    case 'stress':
      await stress();
      break;
    case 'quota-race':
      await quotaRace();
      break;
    default:
      throw new Error(`unknown worker command: ${args.cmd}`);
  }
}

main().catch(fail);
