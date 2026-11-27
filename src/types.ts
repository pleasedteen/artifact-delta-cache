export type Digest = string;

/** A contiguous logical artifact range backed by a slice of an immutable blob. */
export interface Extent {
  /** Start offset in the reconstructed artifact. */
  offset: number;
  /** Logical length in bytes. */
  length: number;
  /** Content-addressed blob id (sha256 hex). */
  blob: Digest;
  /** Start offset inside the backing blob. */
  blobOffset: number;
}

export interface OwnerInfo {
  pid: number;
  startTime: number;
  token: string;
  hostname: string;
  createdAt: string;
}

export interface KeyRecord {
  format: 1;
  key: string;
  size: number;
  /** Confirmed whole-artifact sha256, lower-case hex. */
  digest: Digest;
  /** Publication time used as cold score before any successful restore. */
  createdAt: number;
  /** Most recent successful, digest-verified restore. */
  lastRestoredAt: number | null;
  extents: Extent[];
  /** Full retained blob sizes. Shared hashes occur only once in this map. */
  blobSizes: Record<Digest, number>;
}

export interface LeaseRecord {
  format: 1;
  id: string;
  key: string;
  size: number;
  digest: Digest;
  createdAt: number;
  owner: OwnerInfo;
  extents: Extent[];
  blobSizes: Record<Digest, number>;
}

export interface RangeInput {
  /** Byte offset at which {@link data} overwrites the base artifact. */
  offset: number;
  data: Uint8Array | Buffer;
}

export interface FileSource {
  path: string;
}

export type ArtifactInput = Uint8Array | Buffer | FileSource;

export interface PutOptions {
  /** If supplied, the complete artifact must match this digest before publish. */
  expectedDigest?: string;
  /** Overwrite an existing key. Defaults to true for put(). */
  overwrite?: boolean;
}

export interface DeriveOptions {
  baseKey: string;
  ranges: RangeInput[];
  expectedDigest: string;
  /** Derivation is specified as a new key; set true to replace an existing key. */
  overwrite?: boolean;
}

export interface RestoreResult {
  key: string;
  outputPath?: string;
  size: number;
  digest: Digest;
}

export interface KeyStats {
  key: string;
  size: number;
  digest: Digest;
  createdAt: number;
  lastRestoredAt: number | null;
  coldAt: number;
}

export interface CacheStats {
  dir: string;
  quotaBytes: number;
  /** Actual unique retained bytes: blobs, temp writes, and live reader snapshots. */
  occupiedBytes: number;
  availableBytes: number;
  keyCount: number;
  keys: KeyStats[];
}
