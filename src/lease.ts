import fs from 'node:fs/promises';
import path from 'node:path';
import type { Cache } from './cache.js';
import { ReadLeaseReleasedError } from './errors.js';
import { withLock } from './lock.js';
import { readExtentsToBuffer, restoreExtentsToFile } from './materialize.js';
import type { LeaseRecord, RestoreResult } from './types.js';

/**
 * A selected, immutable snapshot. All backing blobs have hard links inside the
 * lease directory before this object is returned. A stopped or slow reader can
 * therefore outlive key withdrawal and CAS garbage collection.
 */
export class ReadLease implements AsyncDisposable {
  readonly record: LeaseRecord;
  readonly dir: string;
  private released = false;

  constructor(
    private readonly cache: Cache,
    record: LeaseRecord,
    dir: string,
  ) {
    this.record = record;
    this.dir = dir;
  }

  get id(): string {
    return this.record.id;
  }

  get key(): string {
    return this.record.key;
  }

  get digest(): string {
    return this.record.digest;
  }

  get size(): number {
    return this.record.size;
  }

  private blobPath = (hash: string): string => path.join(this.dir, 'data', `${hash}.bin`);

  async restoreTo(outputPath: string): Promise<RestoreResult> {
    if (this.released) throw new ReadLeaseReleasedError(this.record.id);
    const digest = await restoreExtentsToFile(
      this.record.extents,
      this.record.size,
      this.blobPath,
      outputPath,
      this.record.digest,
    );
    await this.cache.noteRestoreSuccess(this.record);
    return { key: this.record.key, outputPath, size: this.record.size, digest };
  }

  async toBuffer(): Promise<Buffer> {
    if (this.released) throw new ReadLeaseReleasedError(this.record.id);
    const buffer = await readExtentsToBuffer(
      this.record.extents,
      this.record.size,
      this.blobPath,
      this.record.digest,
    );
    await this.cache.noteRestoreSuccess(this.record);
    return buffer;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    // Take the cache mutex so eviction planning never observes a half-removed
    // lease directory. The lock is not held during reader IO or while paused.
    await withLock(
      this.cache.dir,
      () => fs.rm(this.dir, { recursive: true, force: true }),
      { timeoutMs: this.cache.lockTimeoutMs },
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}
