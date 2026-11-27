export { Cache, newStagingName } from './cache.js';
export type { CacheOptions, MutationResult, GcResult } from './cache.js';
export { ReadLease } from './lease.js';
export { withLock } from './lock.js';
export { measureCacheDataUsage, parseSize, sha256 } from './fsutil.js';
export * from './errors.js';
export type {
  ArtifactInput,
  CacheStats,
  DeriveOptions,
  Extent,
  KeyRecord,
  KeyStats,
  LeaseRecord,
  PutOptions,
  RangeInput,
  RestoreResult,
} from './types.js';
