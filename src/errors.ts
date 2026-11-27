export type ErrorCode =
  | 'LOCK_TIMEOUT'
  | 'NOT_FOUND'
  | 'KEY_EXISTS'
  | 'DIGEST_MISMATCH'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_ARGUMENT'
  | 'CORRUPT_CACHE'
  | 'READER_RELEASED';

export class CacheError extends Error {
  code: ErrorCode | string = 'CACHE_ERROR';
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'CacheError';
    this.details = details;
  }
}

export class LockTimeoutError extends CacheError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'LockTimeoutError';
    this.code = 'LOCK_TIMEOUT';
  }
}

export class NotFoundError extends CacheError {
  constructor(key: string, details?: unknown) {
    super(`cache key not found: ${key}`, details);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
  }
}

export class KeyExistsError extends CacheError {
  constructor(key: string, details?: unknown) {
    super(`cache key already exists: ${key}`, details);
    this.name = 'KeyExistsError';
    this.code = 'KEY_EXISTS';
  }
}

export class DigestMismatchError extends CacheError {
  expected: string;
  actual: string;

  constructor(expected: string, actual: string, details?: unknown) {
    super(`whole-artifact digest mismatch: expected ${expected}, got ${actual}`, details);
    this.name = 'DigestMismatchError';
    this.code = 'DIGEST_MISMATCH';
    this.expected = expected;
    this.actual = actual;
  }
}

export class QuotaExceededError extends CacheError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'QuotaExceededError';
    this.code = 'QUOTA_EXCEEDED';
  }
}

export class InvalidArgumentError extends CacheError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'InvalidArgumentError';
    this.code = 'INVALID_ARGUMENT';
  }
}

export class CorruptCacheError extends CacheError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'CorruptCacheError';
    this.code = 'CORRUPT_CACHE';
  }
}

export class ReadLeaseReleasedError extends CacheError {
  constructor(leaseId: string) {
    super(`read lease already released: ${leaseId}`);
    this.name = 'ReadLeaseReleasedError';
    this.code = 'READER_RELEASED';
  }
}
