import { InvalidArgumentError } from './errors.js';
import type { Extent, KeyRecord, LeaseRecord } from './types.js';

export interface PreparedRange {
  offset: number;
  end: number;
  blob: string;
}

export function assertContiguousExtents(extents: Extent[], size: number): void {
  let expected = 0;
  for (const extent of extents) {
    if (extent.length <= 0) throw new InvalidArgumentError('extent has non-positive length', { extent });
    if (extent.offset !== expected) {
      throw new InvalidArgumentError('extents are not contiguous', { expected, extent });
    }
    if (extent.blobOffset < 0) throw new InvalidArgumentError('negative blob offset', { extent });
    expected = extent.offset + extent.length;
  }
  if (expected !== size) {
    throw new InvalidArgumentError('extent total does not match artifact size', { expected, size });
  }
}

/**
 * Flatten overwrite ranges into extents that point directly at immutable blobs.
 *
 * Chain-derived artifacts therefore do not retain obsolete parent patches:
 * after replacing a range, the new manifest points at the new range blob and
 * at the original underlying blobs for every untouched byte.
 */
export function flattenExtents(
  baseExtents: Extent[],
  size: number,
  ranges: PreparedRange[],
): Extent[] {
  const sortedBase = [...baseExtents].sort((a, b) => a.offset - b.offset);
  assertContiguousExtents(sortedBase, size);

  const sortedRanges = [...ranges].sort((a, b) => a.offset - b.offset);
  let previousEnd = 0;
  for (const range of sortedRanges) {
    if (!Number.isInteger(range.offset) || range.offset < 0 || range.end > size) {
      throw new InvalidArgumentError('overwrite range is outside the base artifact', {
        range,
        size,
      });
    }
    if (range.end <= range.offset) {
      throw new InvalidArgumentError('overwrite range must have positive length', { range });
    }
    if (range.offset < previousEnd) {
      throw new InvalidArgumentError('overwrite ranges overlap', { ranges: sortedRanges });
    }
    previousEnd = range.end;
  }

  const result: Extent[] = [];
  let position = 0;
  let baseIndex = 0;
  let rangeIndex = 0;

  while (position < size) {
    while (
      baseIndex < sortedBase.length &&
      sortedBase[baseIndex]!.offset + sortedBase[baseIndex]!.length <= position
    ) {
      baseIndex += 1;
    }
    const base = sortedBase[baseIndex];
    if (!base || position < base.offset || position >= base.offset + base.length) {
      throw new InvalidArgumentError('base manifest does not cover requested offset', {
        position,
      });
    }

    while (
      rangeIndex < sortedRanges.length &&
      sortedRanges[rangeIndex]!.end <= position
    ) {
      rangeIndex += 1;
    }
    const range = sortedRanges[rangeIndex];

    if (range && range.offset <= position && position < range.end) {
      const end = range.end;
      result.push({
        offset: position,
        length: end - position,
        blob: range.blob,
        blobOffset: position - range.offset,
      });
      position = end;
    } else {
      let end = base.offset + base.length;
      if (range && range.offset > position && range.offset < end) end = range.offset;
      if (end <= position) throw new InvalidArgumentError('internal extent flattening error');
      result.push({
        offset: position,
        length: end - position,
        blob: base.blob,
        blobOffset: base.blobOffset + (position - base.offset),
      });
      position = end;
    }
  }

  assertContiguousExtents(result, size);
  return result;
}

/**
 * Bytes that must remain after a transaction: unique blobs referenced by key
 * manifests plus blob inodes pinned by live reader leases. Metadata is ignored.
 */
export function projectedUsageBytes(
  records: Iterable<KeyRecord>,
  planned: KeyRecord | null,
  leases: Iterable<LeaseRecord>,
): number {
  const sizes = new Map<string, number>();
  const add = (hash: string, size: number | undefined) => {
    if (typeof size === 'number' && Number.isFinite(size) && size >= 0 && !sizes.has(hash)) {
      sizes.set(hash, size);
    }
  };

  if (planned) {
    for (const [hash, size] of Object.entries(planned.blobSizes)) add(hash, size);
  }
  for (const record of records) {
    for (const [hash, size] of Object.entries(record.blobSizes)) add(hash, size);
  }
  for (const lease of leases) {
    for (const [hash, size] of Object.entries(lease.blobSizes ?? {})) add(hash, size);
  }

  let total = 0;
  for (const size of sizes.values()) total += size;
  return total;
}

export function coldScore(record: Pick<KeyRecord, 'createdAt' | 'lastRestoredAt'>): number {
  return record.lastRestoredAt ?? record.createdAt;
}

export function compareColdest(
  a: KeyRecord,
  b: KeyRecord,
): number {
  const byTime = coldScore(a) - coldScore(b);
  if (byTime !== 0) return byTime;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
