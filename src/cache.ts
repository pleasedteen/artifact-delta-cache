import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CacheError,
  CorruptCacheError,
  DigestMismatchError,
  InvalidArgumentError,
  KeyExistsError,
  NotFoundError,
  QuotaExceededError,
} from './errors.js';
import {
  hashFile,
  measureCacheDataUsage,
  normalizeDigest,
  parseSize,
  randomToken,
  readJsonFile,
  sha256,
  writeJsonAtomic,
} from './fsutil.js';
import { withLock } from './lock.js';
import {
  coldScore,
  compareColdest,
  flattenExtents,
  projectedUsageBytes,
} from './manifest.js';
import { hashExtents } from './materialize.js';
import { getSelfStartTime, isOwnerAlive } from './proc.js';
import { ReadLease } from './lease.js';
import type {
  ArtifactInput,
  CacheStats,
  DeriveOptions,
  KeyRecord,
  KeyStats,
  LeaseRecord,
  PutOptions,
  RangeInput,
  RestoreResult,
} from './types.js';

const DEFAULT_QUOTA_BYTES = 9 * 1024 * 1024;

export interface CacheOptions {
  dir: string;
  quotaBytes?: number | string;
  lockTimeoutMs?: number;
  now?: () => number;
  /** Open and recover stale processes/quota. Defaults to true. */
  recover?: boolean;
}

export interface MutationResult extends KeyStats {
  evictedKeys: string[];
  projectedBytes: number;
}

export interface GcResult {
  occupiedBytes: number;
  removedKeys?: string[];
}

interface StagedArtifact {
  stagingPath: string;
  size: number;
  digest: string;
}

interface PreparedPart {
  offset: number;
  end: number;
  hash: string;
  stagingPath: string;
  size: number;
}

export function newStagingName(): string {
  return `w-${process.pid}-${getSelfStartTime()}-${randomToken(8)}.tmp`;
}

export class Cache {
  readonly dir: string;
  readonly quotaBytes: number;
  readonly lockTimeoutMs: number;
  readonly now: () => number;

  readonly keysDir: string;
  readonly blobsDir: string;
  readonly tmpDir: string;
  readonly readersDir: string;
  readonly locksDir: string;

  constructor(options: CacheOptions) {
    if (!options?.dir || typeof options.dir !== 'string') {
      throw new InvalidArgumentError('Cache.open requires a non-empty dir');
    }
    this.dir = path.resolve(options.dir);
    this.quotaBytes = parseSize(options.quotaBytes, DEFAULT_QUOTA_BYTES);
    if (!Number.isInteger(this.quotaBytes) || this.quotaBytes < 0) {
      throw new InvalidArgumentError('quotaBytes must be a non-negative integer');
    }
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());

    this.keysDir = path.join(this.dir, 'keys');
    this.blobsDir = path.join(this.dir, 'blobs');
    this.tmpDir = path.join(this.dir, 'tmp');
    this.readersDir = path.join(this.dir, 'readers');
    this.locksDir = path.join(this.dir, 'locks');
  }

  static async open(options: CacheOptions): Promise<Cache> {
    const cache = new Cache(options);
    await cache.ensureLayout();
    if (options.recover !== false) {
      await withLock(cache.dir, () => cache.recoverLocked(), {
        timeoutMs: cache.lockTimeoutMs,
      });
    }
    return cache;
  }

  keyPath(key: string): string {
    const id = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    return path.join(this.keysDir, `${id}.json`);
  }

  blobPath(hash: string): string {
    return path.join(this.blobsDir, hash.slice(0, 2), `${hash}.bin`);
  }

  // ---------------------------------------------------------------------------
  // Layout, recovery, and garbage collection
  // ---------------------------------------------------------------------------

  private async ensureLayout(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await Promise.all([
      fs.mkdir(this.keysDir, { recursive: true }),
      fs.mkdir(this.blobsDir, { recursive: true }),
      fs.mkdir(this.tmpDir, { recursive: true }),
      fs.mkdir(this.readersDir, { recursive: true }),
      fs.mkdir(this.locksDir, { recursive: true }),
    ]);

    const formatPath = path.join(this.dir, 'format.json');
    try {
      await fs.access(formatPath);
    } catch {
      await writeJsonAtomic(formatPath, {
        format: 1,
        createdAt: new Date().toISOString(),
      });
    }
  }

  private async recoverLocked(): Promise<void> {
    await this.cleanKeyTemporaryFilesLocked();
    await this.reapStagingLocked();
    await this.reapLeasesLocked();
    const records = await this.readAllRecordsLocked();
    await this.gcBlobsLocked(records);
    await this.enforceQuotaRecoveryLocked(records);
  }

  private async prepareTransactionLocked(): Promise<Map<string, KeyRecord>> {
    await this.cleanKeyTemporaryFilesLocked();
    await this.reapStagingLocked();
    await this.reapLeasesLocked();
    const records = await this.readAllRecordsLocked();
    await this.gcBlobsLocked(records);
    return records;
  }

  private async cleanKeyTemporaryFilesLocked(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.keysDir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith('.tmp'))
        .map((name) => fs.rm(path.join(this.keysDir, name), { force: true })),
    );
  }

  private async reapStagingLocked(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.tmpDir);
    } catch {
      return;
    }

    await Promise.all(
      names.map(async (name) => {
        const full = path.join(this.tmpDir, name);
        let stat;
        try {
          stat = await fs.lstat(full);
        } catch {
          return;
        }
        if (!stat.isFile()) return;

        const match = /^w-(\d+)-(\d+)-([a-f0-9]+)\.tmp$/.exec(name);
        if (!match) {
          await fs.rm(full, { force: true });
          return;
        }
        const owner = { pid: Number(match[1]), startTime: Number(match[2]) };
        if (!isOwnerAlive(owner)) await fs.rm(full, { force: true });
      }),
    );
  }

  private async reapLeasesLocked(): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(this.readersDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dir = path.join(this.readersDir, entry.name);
          const leasePath = path.join(dir, 'lease.json');
          try {
            const lease = await readJsonFile<LeaseRecord>(leasePath);
            if (isOwnerAlive(lease.owner)) return;
          } catch {
            // Missing/incomplete/invalid lease under the cache lock is a crashed lease.
          }
          await fs.rm(dir, { recursive: true, force: true });
        }),
    );
  }

  private async readLeasesLocked(): Promise<LeaseRecord[]> {
    let entries;
    try {
      entries = await fs.readdir(this.readersDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const leases: LeaseRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const lease = await readJsonFile<LeaseRecord>(
          path.join(this.readersDir, entry.name, 'lease.json'),
        );
        leases.push(lease);
      } catch {
        // reapLeasesLocked removes invalid directories before quota decisions.
      }
    }
    return leases;
  }

  private async readAllRecordsLocked(): Promise<Map<string, KeyRecord>> {
    const records = new Map<string, KeyRecord>();
    let names: string[];
    try {
      names = await fs.readdir(this.keysDir);
    } catch {
      return records;
    }

    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await readJsonFile<KeyRecord>(path.join(this.keysDir, name));
      if (record.format !== 1 || typeof record.key !== 'string') {
        throw new CacheError(`invalid key record: ${name}`);
      }
      records.set(record.key, record);
    }
    return records;
  }

  private async readAllRecordsForStats(): Promise<Map<string, KeyRecord>> {
    const records = new Map<string, KeyRecord>();
    let names: string[];
    try {
      names = await fs.readdir(this.keysDir);
    } catch {
      return records;
    }

    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            const record = await readJsonFile<KeyRecord>(path.join(this.keysDir, name));
            records.set(record.key, record);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }),
    );
    return records;
  }

  private async gcBlobsLocked(records?: Map<string, KeyRecord>): Promise<void> {
    const current = records ?? (await this.readAllRecordsLocked());
    const referenced = new Set<string>();
    for (const record of current.values()) {
      for (const hash of Object.keys(record.blobSizes ?? {})) referenced.add(hash);
      for (const extent of record.extents ?? []) referenced.add(extent.blob);
    }

    let shards;
    try {
      shards = await fs.readdir(this.blobsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardPath = path.join(this.blobsDir, shard.name);
      let files;
      try {
        files = await fs.readdir(shardPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.bin')) continue;
        const hash = file.name.slice(0, -'.bin'.length);
        if (!referenced.has(hash)) {
          await fs.rm(path.join(shardPath, file.name), { force: true });
        }
      }
      await fs.rmdir(shardPath).catch(() => undefined);
    }
  }

  private async enforceQuotaRecoveryLocked(
    records: Map<string, KeyRecord>,
  ): Promise<string[]> {
    const leases = await this.readLeasesLocked();
    let projected = projectedUsageBytes(records.values(), null, leases);
    if (projected <= this.quotaBytes) return [];

    const evicted: string[] = [];
    for (const record of [...records.values()].sort(compareColdest)) {
      if (projected <= this.quotaBytes) break;
      await fs.rm(this.keyPath(record.key), { force: true });
      records.delete(record.key);
      evicted.push(record.key);
      projected = projectedUsageBytes(records.values(), null, leases);
    }

    await this.gcBlobsLocked(records);
    if (projected > this.quotaBytes) {
      throw new QuotaExceededError('cache cannot be recovered within quota', {
        dir: this.dir,
        quotaBytes: this.quotaBytes,
        projectedBytes: projected,
        evictedKeys: evicted,
      });
    }
    return evicted;
  }

  // ---------------------------------------------------------------------------
  // Public inspection
  // ---------------------------------------------------------------------------

  async has(key: string): Promise<boolean> {
    this.assertKey(key);
    try {
      await fs.access(this.keyPath(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async stats(): Promise<CacheStats> {
    const [usage, records] = await Promise.all([
      measureCacheDataUsage({
        blobsDir: this.blobsDir,
        tmpDir: this.tmpDir,
        readersDir: this.readersDir,
      }),
      this.readAllRecordsForStats(),
    ]);

    const keys = [...records.values()]
      .map((record): KeyStats => ({
        key: record.key,
        size: record.size,
        digest: record.digest,
        createdAt: record.createdAt,
        lastRestoredAt: record.lastRestoredAt,
        coldAt: coldScore(record),
      }))
      .sort((a, b) => a.coldAt - b.coldAt || (a.key < b.key ? -1 : 1));

    return {
      dir: this.dir,
      quotaBytes: this.quotaBytes,
      occupiedBytes: usage.bytes,
      availableBytes: Math.max(0, this.quotaBytes - usage.bytes),
      keyCount: records.size,
      keys,
    };
  }

  async occupancy(): Promise<number> {
    return (await this.stats()).occupiedBytes;
  }

  async gc(): Promise<GcResult> {
    return withLock(
      this.dir,
      async () => {
        await this.cleanKeyTemporaryFilesLocked();
        await this.reapStagingLocked();
        await this.reapLeasesLocked();
        const records = await this.readAllRecordsLocked();
        await this.gcBlobsLocked(records);
        const usage = await measureCacheDataUsage({
          blobsDir: this.blobsDir,
          tmpDir: this.tmpDir,
          readersDir: this.readersDir,
        });
        return { occupiedBytes: usage.bytes };
      },
      { timeoutMs: this.lockTimeoutMs },
    );
  }

  async close(): Promise<void> {
    // All long-lived state is on disk and operations release the process lock.
  }

  // ---------------------------------------------------------------------------
  // Full artifact put
  // ---------------------------------------------------------------------------

  async put(key: string, input: ArtifactInput, options: PutOptions = {}): Promise<MutationResult> {
    this.assertKey(key);
    const overwrite = options.overwrite ?? true;
    const staged = await this.stageArtifact(input);

    let expected: string | undefined;
    if (options.expectedDigest !== undefined) {
      try {
        expected = normalizeDigest(options.expectedDigest);
      } catch (error) {
        await fs.rm(staged.stagingPath, { force: true });
        throw new InvalidArgumentError((error as Error).message);
      }
      if (expected !== staged.digest) {
        await fs.rm(staged.stagingPath, { force: true });
        throw new DigestMismatchError(expected!, staged.digest);
      }
    }

    try {
      return await withLock(
        this.dir,
        () => this.commitPutLocked(key, staged, overwrite),
        { timeoutMs: this.lockTimeoutMs },
      );
    } catch (error) {
      await fs.rm(staged.stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async stageArtifact(input: ArtifactInput): Promise<StagedArtifact> {
    const stagingPath = path.join(this.tmpDir, newStagingName());
    await fs.mkdir(this.tmpDir, { recursive: true });

    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      const handle = await fs.open(stagingPath, 'wx', 0o600);
      try {
        await handle.writeFile(input);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else if (input && typeof input === 'object' && 'path' in input && typeof input.path === 'string') {
      await fs.copyFile(input.path, stagingPath, fs.constants.COPYFILE_EXCL);
      const handle = await fs.open(stagingPath, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new InvalidArgumentError(
        'put input must be a Buffer, Uint8Array, or { path: string }',
      );
    }

    const stat = await fs.stat(stagingPath);
    const digest = await hashFile(stagingPath);
    return { stagingPath, size: stat.size, digest };
  }

  private async commitPutLocked(
    key: string,
    staged: StagedArtifact,
    overwrite: boolean,
  ): Promise<MutationResult> {
    const records = await this.prepareTransactionLocked();
    if (!overwrite && records.has(key)) throw new KeyExistsError(key);

    const record: KeyRecord = {
      format: 1,
      key,
      size: staged.size,
      digest: staged.digest,
      createdAt: this.now(),
      lastRestoredAt: null,
      extents:
        staged.size === 0
          ? []
          : [{ offset: 0, length: staged.size, blob: staged.digest, blobOffset: 0 }],
      blobSizes: { [staged.digest]: staged.size },
    };

    const choice = await this.chooseEvictionsLocked(records, record);

    await this.promoteStagingBlob(staged.stagingPath, staged.digest);
    if (overwrite) await fs.rm(this.keyPath(key), { force: true });
    for (const evictedKey of choice.evictedKeys) {
      await fs.rm(this.keyPath(evictedKey), { force: true });
      records.delete(evictedKey);
    }

    await writeJsonAtomic(this.keyPath(key), record);
    records.set(key, record);
    await this.gcBlobsLocked(records);

    return {
      key,
      size: record.size,
      digest: record.digest,
      createdAt: record.createdAt,
      lastRestoredAt: null,
      coldAt: record.createdAt,
      evictedKeys: choice.evictedKeys,
      projectedBytes: choice.projectedBytes,
    };
  }

  // ---------------------------------------------------------------------------
  // Derivation
  // ---------------------------------------------------------------------------

  async derive(newKey: string, options: DeriveOptions): Promise<MutationResult> {
    this.assertKey(newKey);
    if (!options || typeof options.baseKey !== 'string' || options.baseKey.length === 0) {
      throw new InvalidArgumentError('derive requires a baseKey');
    }
    if (!Array.isArray(options.ranges)) {
      throw new InvalidArgumentError('derive requires a ranges array');
    }

    let expected: string;
    try {
      expected = normalizeDigest(options.expectedDigest)!;
    } catch (error) {
      throw new InvalidArgumentError((error as Error).message);
    }
    if (!expected) throw new InvalidArgumentError('derive requires expectedDigest');

    return withLock(
      this.dir,
      () => this.deriveLocked(newKey, expected, options),
      { timeoutMs: this.lockTimeoutMs },
    );
  }

  private async deriveLocked(
    newKey: string,
    expected: string,
    options: DeriveOptions,
  ): Promise<MutationResult> {
    const records = await this.prepareTransactionLocked();
    const overwrite = options.overwrite ?? false;
    if (!overwrite && records.has(newKey)) throw new KeyExistsError(newKey);

    const base = records.get(options.baseKey);
    if (!base) throw new NotFoundError(options.baseKey);

    const parts: PreparedPart[] = [];
    try {
      for (const range of options.ranges as RangeInput[]) {
        if (!range || !Number.isInteger(range.offset) || range.offset < 0) {
          throw new InvalidArgumentError('range.offset must be a non-negative integer', { range });
        }
        if (!(range.data instanceof Uint8Array)) {
          throw new InvalidArgumentError('range.data must be a Buffer or Uint8Array', { range });
        }
        const data = Buffer.isBuffer(range.data) ? range.data : Buffer.from(range.data);
        if (data.length === 0) {
          throw new InvalidArgumentError('range.data must not be empty', { range });
        }
        if (range.offset + data.length > base.size) {
          throw new InvalidArgumentError('overwrite range extends beyond base artifact', {
            offset: range.offset,
            length: data.length,
            baseSize: base.size,
          });
        }

        const hash = sha256(data);
        const stagingPath = path.join(this.tmpDir, newStagingName());
        const handle = await fs.open(stagingPath, 'wx', 0o600);
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        parts.push({
          offset: range.offset,
          end: range.offset + data.length,
          hash,
          stagingPath,
          size: data.length,
        });
      }

      const extents = flattenExtents(
        base.extents,
        base.size,
        parts.map((part) => ({ offset: part.offset, end: part.end, blob: part.hash })),
      );
      const partByHash = new Map<string, PreparedPart>();
      for (const part of parts) if (!partByHash.has(part.hash)) partByHash.set(part.hash, part);

      const blobSizes: Record<string, number> = {};
      for (const hash of new Set(extents.map((extent) => extent.blob))) {
        const part = partByHash.get(hash);
        if (part) {
          blobSizes[hash] = part.size;
        } else if (typeof base.blobSizes?.[hash] === 'number') {
          blobSizes[hash] = base.blobSizes[hash]!;
        } else {
          const stat = await fs.stat(this.blobPath(hash));
          blobSizes[hash] = stat.size;
        }
      }

      const actual = await hashExtents(extents, (hash) => {
        const part = partByHash.get(hash);
        if (part) return part.stagingPath;
        return this.blobPath(hash);
      });

      if (actual !== expected) {
        throw new DigestMismatchError(expected, actual);
      }

      const record: KeyRecord = {
        format: 1,
        key: newKey,
        size: base.size,
        digest: actual,
        createdAt: this.now(),
        lastRestoredAt: null,
        extents,
        blobSizes,
      };

      const choice = await this.chooseEvictionsLocked(records, record);

      for (const part of parts) {
        await this.promoteStagingBlob(part.stagingPath, part.hash);
      }
      if (overwrite) await fs.rm(this.keyPath(newKey), { force: true });
      for (const evictedKey of choice.evictedKeys) {
        await fs.rm(this.keyPath(evictedKey), { force: true });
        records.delete(evictedKey);
      }

      await writeJsonAtomic(this.keyPath(newKey), record);
      records.set(newKey, record);
      await this.gcBlobsLocked(records);

      return {
        key: newKey,
        size: record.size,
        digest: record.digest,
        createdAt: record.createdAt,
        lastRestoredAt: null,
        coldAt: record.createdAt,
        evictedKeys: choice.evictedKeys,
        projectedBytes: choice.projectedBytes,
      };
    } catch (error) {
      await Promise.all(
        parts.map((part) => fs.rm(part.stagingPath, { force: true }).catch(() => undefined)),
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Restore / readers
  // ---------------------------------------------------------------------------

  async openRead(key: string): Promise<ReadLease> {
    this.assertKey(key);
    return withLock(
      this.dir,
      async () => {
        const records = await this.prepareTransactionLocked();
        const record = records.get(key);
        if (!record) throw new NotFoundError(key);

        const id = `${this.now().toString(36)}-${randomToken(6)}`;
        const leaseDir = path.join(this.readersDir, id);
        const dataDir = path.join(leaseDir, 'data');
        await fs.mkdir(dataDir, { recursive: true });

        const hashes = new Set<string>([
          ...Object.keys(record.blobSizes ?? {}),
          ...record.extents.map((extent) => extent.blob),
        ]);
        const blobSizes: Record<string, number> = { ...(record.blobSizes ?? {}) };

        for (const hash of hashes) {
          const source = this.blobPath(hash);
          const destination = path.join(dataDir, `${hash}.bin`);
          try {
            await fs.link(source, destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new CorruptCacheError(
                `published key ${key} references missing blob ${hash}`,
              );
            }
            throw error;
          }
          if (blobSizes[hash] === undefined) {
            blobSizes[hash] = (await fs.stat(source)).size;
          }
        }

        const lease: LeaseRecord = {
          format: 1,
          id,
          key,
          size: record.size,
          digest: record.digest,
          createdAt: this.now(),
          owner: {
            pid: process.pid,
            startTime: getSelfStartTime(),
            token: randomToken(12),
            hostname: os.hostname(),
            createdAt: new Date().toISOString(),
          },
          extents: record.extents,
          blobSizes,
        };

        await writeJsonAtomic(path.join(leaseDir, 'lease.json'), lease);
        return new ReadLease(this, lease, leaseDir);
      },
      { timeoutMs: this.lockTimeoutMs },
    );
  }

  async restore(key: string, outputPath: string): Promise<RestoreResult> {
    const lease = await this.openRead(key);
    try {
      return await lease.restoreTo(outputPath);
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  async read(key: string): Promise<Buffer> {
    const lease = await this.openRead(key);
    try {
      return await lease.toBuffer();
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  /** Update coldness only after a whole-artifact digest has verified. */
  async noteRestoreSuccess(snapshot: LeaseRecord): Promise<void> {
    await withLock(
      this.dir,
      async () => {
        let record: KeyRecord;
        try {
          record = await readJsonFile<KeyRecord>(this.keyPath(snapshot.key));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        if (record.digest === snapshot.digest && record.size === snapshot.size) {
          record.lastRestoredAt = this.now();
          await writeJsonAtomic(this.keyPath(snapshot.key), record);
        }
      },
      { timeoutMs: this.lockTimeoutMs },
    );
  }

  // ---------------------------------------------------------------------------
  // Removal and eviction planning
  // ---------------------------------------------------------------------------

  async remove(key: string): Promise<boolean> {
    this.assertKey(key);
    return withLock(
      this.dir,
      async () => {
        const records = await this.prepareTransactionLocked();
        const existed = records.has(key);
        await fs.rm(this.keyPath(key), { force: true });
        if (existed) records.delete(key);
        await this.gcBlobsLocked(records);
        return existed;
      },
      { timeoutMs: this.lockTimeoutMs },
    );
  }

  delete(key: string): Promise<boolean> {
    return this.remove(key);
  }

  withdraw(key: string): Promise<boolean> {
    return this.remove(key);
  }

  private async chooseEvictionsLocked(
    records: Map<string, KeyRecord>,
    planned: KeyRecord,
  ): Promise<{ evictedKeys: string[]; projectedBytes: number }> {
    const leases = await this.readLeasesLocked();

    // Replacing the same key removes its old manifest from the projection.
    const remaining = new Map<string, KeyRecord>();
    for (const [key, record] of records) {
      if (key !== planned.key) remaining.set(key, record);
    }

    const candidates = [...remaining.values()].sort(compareColdest);
    let projectedBytes = projectedUsageBytes(remaining.values(), planned, leases);
    const evictedKeys: string[] = [];

    for (const candidate of candidates) {
      if (projectedBytes <= this.quotaBytes) break;
      remaining.delete(candidate.key);
      evictedKeys.push(candidate.key);
      projectedBytes = projectedUsageBytes(remaining.values(), planned, leases);
    }

    if (projectedBytes > this.quotaBytes) {
      throw new QuotaExceededError(
        'not enough reclaimable cache space for write; existing keys were not changed',
        {
          quotaBytes: this.quotaBytes,
          projectedBytes,
          plannedKey: planned.key,
          plannedSize: planned.size,
          coldEvictionOrder: candidates.map((candidate) => candidate.key),
          attemptedEvictedKeys: evictedKeys,
        },
      );
    }

    return { evictedKeys, projectedBytes };
  }

  // ---------------------------------------------------------------------------
  // Blob promotion and small validation
  // ---------------------------------------------------------------------------

  private async promoteStagingBlob(stagingPath: string, hash: string): Promise<void> {
    const destination = this.blobPath(hash);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.link(stagingPath, destination);
      await fs.rm(stagingPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await fs.rm(stagingPath, { force: true });
        return;
      }
      throw error;
    }
  }

  private assertKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || key.length === 0) {
      throw new InvalidArgumentError('key must be a non-empty string');
    }
  }
}
