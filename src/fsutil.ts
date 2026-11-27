import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Digest } from './types.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomToken(bytes = 9): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(data: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function normalizeDigest(expected: string | undefined): Digest | undefined {
  if (expected === undefined) return undefined;
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(expected.trim());
  if (!match) {
    throw new Error(`invalid sha256 digest: ${expected}`);
  }
  return match[1]!.toLowerCase();
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export async function fsyncDirectory(dirPath: string): Promise<void> {
  try {
    const handle = await fs.open(dirPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some filesystems do not support directory fsync; process SIGKILL does not require it.
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomToken(6)}.tmp`,
  );
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
  await fsyncDirectory(dir);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Count actual artifact bytes retained in cache data locations.
 *
 * Metadata and lock files are absent from the scanned roots. Hard links between
 * CAS blobs and reader snapshots have the same dev/inode and are counted once.
 * Files that disappear while scanned are ignored.
 */
export async function measureCacheDataUsage(layout: {
  blobsDir: string;
  tmpDir: string;
  readersDir: string;
}): Promise<{ bytes: number; files: number }> {
  const seenInodes = new Set<string>();
  let bytes = 0;
  let files = 0;

  const countFile = async (filePath: string): Promise<void> => {
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile()) return;
      const inodeKey = `${stat.dev}:${stat.ino}`;
      if (seenInodes.has(inodeKey)) return;
      seenInodes.add(inodeKey);
      bytes += stat.size;
      files += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  };

  for await (const file of walkFiles(layout.blobsDir)) await countFile(file);
  for await (const file of walkFiles(layout.tmpDir)) await countFile(file);

  // Only readers/<id>/data contains artifact bytes. lease.json is metadata.
  let leaseDirs: string[] = [];
  try {
    leaseDirs = (await fs.readdir(layout.readersDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(layout.readersDir, entry.name, 'data'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const dataDir of leaseDirs) {
    for await (const file of walkFiles(dataDir)) await countFile(file);
  }

  return { bytes, files };
}

/** Parse sizes such as 8192, "64KiB", "9 MiB", "1gb". */
export function parseSize(input: string | number | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  if (typeof input === 'number') return input;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?i?b?|bytes?)\s*$/i.exec(input);
  if (!match) {
    const n = Number(input);
    if (Number.isFinite(n)) return n;
    throw new Error(`invalid size: ${input}`);
  }
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  let multiplier = 1;
  if (unit.startsWith('k')) multiplier = 1024;
  else if (unit.startsWith('m')) multiplier = 1024 ** 2;
  else if (unit.startsWith('g')) multiplier = 1024 ** 3;
  return Math.floor(value * multiplier);
}
