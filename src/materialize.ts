import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomToken, fsyncDirectory, normalizeDigest } from './fsutil.js';
import { CorruptCacheError, DigestMismatchError } from './errors.js';
import type { Extent } from './types.js';

export type BlobLocator = (blobHash: string) => string | Promise<string>;

export async function hashExtents(extents: Extent[], locate: BlobLocator): Promise<string> {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  for (const extent of extents) {
    const blobPath = await locate(extent.blob);
    const handle = await fs.open(blobPath, 'r');
    try {
      let remaining = extent.length;
      let position = extent.blobOffset;
      while (remaining > 0) {
        const wanted = Math.min(buffer.length, remaining);
        const { bytesRead } = await handle.read(buffer, 0, wanted, position);
        if (bytesRead === 0) {
          throw new CorruptCacheError(`unexpected EOF while hashing blob ${extent.blob}`);
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
        remaining -= bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  return hash.digest('hex');
}

export async function readExtentsToBuffer(
  extents: Extent[],
  size: number,
  locate: BlobLocator,
  expectedDigest: string,
): Promise<Buffer> {
  const output = Buffer.allocUnsafe(size);
  const hash = crypto.createHash('sha256');
  let outputOffset = 0;
  const chunk = Buffer.allocUnsafe(1024 * 1024);

  for (const extent of extents) {
    const blobPath = await locate(extent.blob);
    const handle = await fs.open(blobPath, 'r');
    try {
      let remaining = extent.length;
      let position = extent.blobOffset;
      while (remaining > 0) {
        const wanted = Math.min(chunk.length, remaining);
        const { bytesRead } = await handle.read(chunk, 0, wanted, position);
        if (bytesRead === 0) {
          throw new CorruptCacheError(`unexpected EOF while reading blob ${extent.blob}`);
        }
        const part = chunk.subarray(0, bytesRead);
        part.copy(output, outputOffset);
        hash.update(part);
        outputOffset += bytesRead;
        position += bytesRead;
        remaining -= bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  if (outputOffset !== size) {
    throw new CorruptCacheError(`materialized size ${outputOffset} != record size ${size}`);
  }

  const actual = hash.digest('hex');
  const expected = normalizeDigest(expectedDigest)!;
  if (actual !== expected) throw new DigestMismatchError(expected, actual);
  return output;
}

/**
 * Reconstruct an artifact to a temporary file, verify its whole digest, and
 * only then atomically rename it to the requested output path. A digest failure
 * removes the temporary file and never creates/replaces the final path.
 */
export async function restoreExtentsToFile(
  extents: Extent[],
  size: number,
  locate: BlobLocator,
  outputPath: string,
  expectedDigest: string,
): Promise<string> {
  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  await fs.mkdir(outputDir, { recursive: true });
  const temporaryPath = path.join(
    outputDir,
    `.${path.basename(resolvedOutput)}.restore-${process.pid}-${randomToken(6)}.tmp`,
  );

  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let outputHandle: fs.FileHandle | undefined;
  let renamed = false;

  try {
    outputHandle = await fs.open(temporaryPath, 'wx', 0o600);
    let written = 0;

    for (const extent of extents) {
      const blobPath = await locate(extent.blob);
      const inputHandle = await fs.open(blobPath, 'r');
      try {
        let remaining = extent.length;
        let inputPosition = extent.blobOffset;
        while (remaining > 0) {
          const wanted = Math.min(chunk.length, remaining);
          const { bytesRead } = await inputHandle.read(chunk, 0, wanted, inputPosition);
          if (bytesRead === 0) {
            throw new CorruptCacheError(`unexpected EOF while restoring blob ${extent.blob}`);
          }
          const part = chunk.subarray(0, bytesRead);
          hash.update(part);
          await outputHandle.write(part);
          written += bytesRead;
          inputPosition += bytesRead;
          remaining -= bytesRead;
        }
      } finally {
        await inputHandle.close();
      }
    }

    if (written !== size) {
      throw new CorruptCacheError(`restored size ${written} != record size ${size}`);
    }

    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = undefined;

    const actual = hash.digest('hex');
    const expected = normalizeDigest(expectedDigest)!;
    if (actual !== expected) {
      throw new DigestMismatchError(expected, actual);
    }

    await fs.rename(temporaryPath, resolvedOutput);
    renamed = true;
    await fsyncDirectory(outputDir);
    return actual;
  } finally {
    if (outputHandle) await outputHandle.close().catch(() => undefined);
    if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
