#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { Cache } from './cache.js';
import { parseSize } from './fsutil.js';
import type { RangeInput } from './types.js';

interface ParsedCommand {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArguments(argv: string[]): ParsedCommand {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equals = withoutPrefix.indexOf('=');
    if (equals >= 0) {
      flags.set(withoutPrefix.slice(0, equals), withoutPrefix.slice(equals + 1));
      continue;
    }

    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(withoutPrefix, next);
      index += 1;
    } else {
      flags.set(withoutPrefix, true);
    }
  }

  return { command, positional, flags };
}

function flagString(parsed: ParsedCommand, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function usage(): string {
  return `linkforge-cache

Usage:
  linkforge-cache put <key> <artifact-file> [--expected-digest sha256:hex] [--dir DIR] [--quota 9m]
  linkforge-cache get <key> <output-file> [--dir DIR] [--quota 9m]
  linkforge-cache derive <new-key> <base-key> <expected-sha256> <ranges.json> [--dir DIR]
  linkforge-cache rm <key> [--dir DIR]
  linkforge-cache stat [--dir DIR]
  linkforge-cache keys [--dir DIR]
  linkforge-cache gc [--dir DIR]
  linkforge-cache serve [--host 127.0.0.1] [--port 4789] [--dir DIR] [--quota 9m]

Environment:
  LINKFORGE_CACHE_DIR  Default cache directory (default: .linkforge-cache)

ranges.json:
  [
    { "offset": 1048576, "dataBase64": "..." },
    { "offset": 2097152, "path": "64k-patch.bin" }
  ]
`;
}

async function readRanges(rangesFile: string): Promise<RangeInput[]> {
  const resolved = path.resolve(rangesFile);
  const raw = JSON.parse(await fs.readFile(resolved, 'utf8')) as Array<{
    offset: number;
    dataBase64?: string;
    data?: string;
    encoding?: BufferEncoding;
    path?: string;
  }>;

  if (!Array.isArray(raw)) throw new Error('ranges file must contain a JSON array');
  const baseDir = path.dirname(resolved);

  return Promise.all(
    raw.map(async (range) => {
      let data: Buffer;
      if (typeof range.dataBase64 === 'string') {
        data = Buffer.from(range.dataBase64, 'base64');
      } else if (typeof range.path === 'string') {
        const patchPath = path.isAbsolute(range.path) ? range.path : path.join(baseDir, range.path);
        data = await fs.readFile(patchPath);
      } else if (typeof range.data === 'string') {
        data = Buffer.from(range.data, range.encoding ?? 'utf8');
      } else {
        throw new Error('each range requires dataBase64, data, or path');
      }
      return { offset: Number(range.offset), data };
    }),
  );
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === 'help' || parsed.flags.has('help') || parsed.flags.has('h')) {
    process.stdout.write(usage());
    return;
  }

  if (parsed.command === 'serve') {
    const { startServer } = await import('./server.js');
    const dir = flagString(parsed, 'dir') ?? process.env.LINKFORGE_CACHE_DIR ?? '.linkforge-cache';
    const quota = parseSize(flagString(parsed, 'quota'), 9 * 1024 * 1024);
    const port = Number(flagString(parsed, 'port') ?? '4789');
    const host = flagString(parsed, 'host') ?? '127.0.0.1';
    await startServer({ dir, quotaBytes: quota, port, host });
    return;
  }

  const dir = flagString(parsed, 'dir') ?? process.env.LINKFORGE_CACHE_DIR ?? '.linkforge-cache';
  const quota = parseSize(flagString(parsed, 'quota'), 9 * 1024 * 1024);
  const cache = await Cache.open({ dir, quotaBytes: quota });

  let result: unknown;

  switch (parsed.command) {
    case 'put': {
      const [key, file] = parsed.positional;
      if (!key || !file) throw new Error('put requires <key> <artifact-file>');
      result = await cache.put(key, { path: path.resolve(file) }, {
        expectedDigest: flagString(parsed, 'expected-digest'),
      });
      break;
    }
    case 'get':
    case 'restore': {
      const [key, output] = parsed.positional;
      if (!key || !output) throw new Error('get requires <key> <output-file>');
      result = { ok: true, ...(await cache.restore(key, path.resolve(output))) };
      break;
    }
    case 'derive': {
      const [newKey, baseKey, expectedDigest, rangesFile] = parsed.positional;
      if (!newKey || !baseKey || !expectedDigest || !rangesFile) {
        throw new Error('derive requires <new-key> <base-key> <expected-digest> <ranges.json>');
      }
      const ranges = await readRanges(rangesFile);
      result = await cache.derive(newKey, { baseKey, expectedDigest, ranges });
      break;
    }
    case 'rm':
    case 'delete':
    case 'withdraw': {
      const [key] = parsed.positional;
      if (!key) throw new Error('rm requires <key>');
      result = { ok: true, key, existed: await cache.remove(key) };
      break;
    }
    case 'stat':
    case 'stats':
      result = { ok: true, ...(await cache.stats()) };
      break;
    case 'keys':
      result = { ok: true, keys: (await cache.stats()).keys };
      break;
    case 'gc':
      result = { ok: true, ...(await cache.gc()) };
      break;
    default:
      throw new Error(`unknown command: ${parsed.command}\n\n${usage()}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: Error & { code?: string; details?: unknown }) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        code: error.code ?? 'CLI_ERROR',
        message: error.message,
        details: error.details,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
});
