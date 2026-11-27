import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { randomToken, sleep } from './fsutil.js';
import { currentOwner, isOwnerAlive } from './proc.js';
import { LockTimeoutError } from './errors.js';
import type { OwnerInfo } from './types.js';

const execFileAsync = promisify(execFileCallback);

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
}

let flockSupported: boolean | undefined;

async function supportsFlock(): Promise<boolean> {
  if (flockSupported !== undefined) return flockSupported;
  try {
    await execFileAsync('flock', ['--version'], { timeout: 5_000 });
    flockSupported = true;
  } catch {
    flockSupported = false;
  }
  return flockSupported;
}

/**
 * Cross-process critical section.
 *
 * On Linux we use util-linux flock(1) as an OS lock owner held by a tiny
 * helper. The lock is released automatically if this process is SIGKILLed,
 * because the helper's stdin pipe reaches EOF and the helper exits. A portable
 * hard-link/PID lock fallback is retained for environments without flock.
 */
export async function withLock<T>(
  cacheDir: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  await fs.mkdir(cacheDir, { recursive: true });
  if (await supportsFlock()) {
    try {
      return await withFlock(cacheDir, fn, options);
    } catch (error) {
      if ((error as { code?: string }).code !== 'FLOCK_SPAWN_FAILED') throw error;
      return withOwnerLock(cacheDir, fn, options);
    }
  }
  return withOwnerLock(cacheDir, fn, options);
}

async function withFlock<T>(
  cacheDir: string,
  fn: () => Promise<T> | T,
  options: LockOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const lockFile = path.join(cacheDir, 'cache.flock');
  await fs.writeFile(lockFile, '', { flag: 'a' });

  const child = spawn(
    'flock',
    [
      '-x',
      lockFile,
      'sh',
      '-c',
      "printf 'LINKFORGE_LOCK_READY\\n'; IFS= read -r __linkforge_lock_hold || true",
      'linkforge-lock-helper',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new LockTimeoutError(`timed out waiting for flock after ${timeoutMs}ms`, { stderr }));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!settled && stdout.includes('LINKFORGE_LOCK_READY')) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`failed to spawn flock: ${error.message}`), {
        code: 'FLOCK_SPAWN_FAILED',
        cause: error,
      }));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LockTimeoutError('flock helper exited before acquiring the lock', {
        code,
        signal,
        stderr,
      }));
    });
  });

  try {
    return await fn();
  } finally {
    await releaseFlockHelper(child);
  }
}

async function releaseFlockHelper(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.stdin?.end();
  });
}

/**
 * Hard-link owner-file mutex with PID/start-time stale-owner detection.
 * Used only when the flock executable is unavailable.
 */
export async function withOwnerLock<T>(
  cacheDir: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryMs = options.retryMs ?? 18;
  const lockPath = path.join(cacheDir, 'lock');
  const locksDir = path.join(cacheDir, 'locks');
  await fs.mkdir(locksDir, { recursive: true });

  const token = randomToken(12);
  const owner = currentOwner(token);
  const ownerTmp = path.join(locksDir, `owner-${token}.json`);
  await fs.writeFile(ownerTmp, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 });

  const deadline = Date.now() + timeoutMs;
  let linked = false;
  let lastErrorCode: string | undefined;

  try {
    while (Date.now() < deadline) {
      try {
        await fs.link(ownerTmp, lockPath);
        linked = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        lastErrorCode = code;
        if (code !== 'EEXIST') throw error;

        let existing: OwnerInfo | undefined;
        try {
          existing = JSON.parse(await fs.readFile(lockPath, 'utf8')) as OwnerInfo;
        } catch {
          existing = undefined;
        }

        if (existing && !isOwnerAlive(existing)) {
          const stalePath = path.join(cacheDir, `lock.stale.${token}`);
          try {
            await fs.rename(lockPath, stalePath);
            await fs.rm(stalePath, { force: true });
          } catch {
            // Another process likely won the takeover; retry and respect its owner.
          }
        }

        const jitter = Math.floor(Math.random() * retryMs);
        await sleep(retryMs + jitter);
      }
    }

    if (!linked) {
      throw new LockTimeoutError(`timed out waiting for cache lock after ${timeoutMs}ms`, {
        lockPath,
        lastErrorCode,
      });
    }

    return await fn();
  } finally {
    if (linked) {
      try {
        const current = JSON.parse(await fs.readFile(lockPath, 'utf8')) as OwnerInfo;
        if (current.token === token) await fs.unlink(lockPath);
      } catch {
        // Stale-owner recovery handles a lost owner file.
      }
    }
    await fs.rm(ownerTmp, { force: true }).catch(() => undefined);
  }
}
