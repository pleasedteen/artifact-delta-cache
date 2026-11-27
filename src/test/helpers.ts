import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
export const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));

export async function makeTempDir(prefix = 'linkforge-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkerMessage {
  type: string;
  [key: string]: unknown;
}

export function startWorker(args: Record<string, unknown>): ChildProcess {
  return fork(workerPath, [JSON.stringify(args)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
  });
}

export function waitForWorkerMessage(
  child: ChildProcess,
  expectedType: string,
  timeoutMs = 30_000,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for worker message ${expectedType}; stderr=${stderr}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };

    const onMessage = (message: WorkerMessage) => {
      if (message.type === 'error') {
        cleanup();
        reject(Object.assign(new Error(String(message.message ?? 'worker error')), message));
        return;
      }
      if (message.type === expectedType) {
        cleanup();
        resolve(message);
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`worker exited before ${expectedType}: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
    };

    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

export async function runWorker(args: Record<string, unknown>): Promise<WorkerMessage> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [workerPath, JSON.stringify(args)],
    { timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (!last) throw new Error(`worker produced no JSON; stderr=${stderr}`);
  return JSON.parse(last) as WorkerMessage;
}

export async function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for worker exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
