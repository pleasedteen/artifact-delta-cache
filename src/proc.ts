import fs from 'node:fs';
import os from 'node:os';
import type { OwnerInfo } from './types.js';

/**
 * Linux starttime field (clock ticks since boot), used to distinguish a live
 * PID from a reused PID after SIGKILL. Returns null when /proc is unavailable.
 */
export function linuxProcessStartTime(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const lastParen = stat.lastIndexOf(')');
    if (lastParen < 0) return null;
    // Fields after comm begin with state as index 0. field 22 (starttime) is index 19.
    const fields = stat.slice(lastParen + 2).split(' ');
    const value = Number(fields[19]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

let selfStartTime: number | undefined;

export function getSelfStartTime(): number {
  if (selfStartTime === undefined) {
    selfStartTime = linuxProcessStartTime(process.pid) ?? 0;
  }
  return selfStartTime;
}

export function currentOwner(token: string): OwnerInfo {
  return {
    pid: process.pid,
    startTime: getSelfStartTime(),
    token,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };
}

export function isOwnerAlive(owner: Partial<OwnerInfo> | undefined | null): boolean {
  if (!owner || !Number.isInteger(owner.pid) || (owner.pid as number) <= 0) return false;
  const pid = owner.pid as number;

  let alive: boolean;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM means the process exists even though we may not signal it.
    if (code === 'EPERM') alive = true;
    else return false;
  }

  if (!alive) return false;

  if (process.platform === 'linux' && owner.startTime && owner.startTime > 0) {
    const actualStart = linuxProcessStartTime(pid);
    if (actualStart !== null) return actualStart === owner.startTime;
  }
  return true;
}
