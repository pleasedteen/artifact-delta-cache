#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cache } from './cache.js';
import { CacheError, InvalidArgumentError } from './errors.js';
import { parseSize } from './fsutil.js';

export interface ServerOptions {
  dir: string;
  quotaBytes?: number | string;
  port?: number;
  host?: string;
  maxBodyBytes?: number;
}

async function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new CacheError('request body too large', { maxBodyBytes: maxBytes }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function statusForError(error: unknown): number {
  const code = (error as CacheError)?.code;
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'KEY_EXISTS':
      return 409;
    case 'INVALID_ARGUMENT':
      return 400;
    case 'DIGEST_MISMATCH':
      return 422;
    case 'QUOTA_EXCEEDED':
      return 507;
    case 'LOCK_TIMEOUT':
      return 503;
    default:
      return 500;
  }
}

export async function startServer(options: ServerOptions): Promise<http.Server> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4789;
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024 * 1024;
  const cache = await Cache.open({
    dir: options.dir,
    quotaBytes: options.quotaBytes,
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/stats') {
        const stats = await cache.stats();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, ...stats }));
        return;
      }

      if (url.pathname === '/v1/keys') {
        const key = url.searchParams.get('key');
        if (!key) throw new InvalidArgumentError('missing ?key=');

        if (request.method === 'PUT') {
          const body = await readBody(request, maxBodyBytes);
          const expectedDigest = request.headers['x-expected-digest'];
          const result = await cache.put(key, body, {
            expectedDigest: Array.isArray(expectedDigest) ? expectedDigest[0] : expectedDigest,
          });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, ...result }));
          return;
        }

        if (request.method === 'GET') {
          const artifact = await cache.read(key);
          const stats = await cache.stats();
          const record = stats.keys.find((item) => item.key === key);
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': artifact.length,
            'x-digest': record?.digest ?? '',
          });
          response.end(artifact);
          return;
        }

        if (request.method === 'DELETE') {
          const existed = await cache.remove(key);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, key, existed }));
          return;
        }
      }

      if (request.method === 'POST' && url.pathname === '/v1/derive') {
        const body = await readBody(request, maxBodyBytes);
        const input = JSON.parse(body.toString('utf8')) as {
          newKey?: string;
          baseKey?: string;
          expectedDigest?: string;
          overwrite?: boolean;
          ranges?: Array<{ offset: number; dataBase64?: string; data?: string }>;
        };
        if (!input.newKey || !input.baseKey || !input.expectedDigest || !Array.isArray(input.ranges)) {
          throw new InvalidArgumentError('derive requires newKey, baseKey, expectedDigest, and ranges');
        }
        const ranges = input.ranges.map((range) => ({
          offset: Number(range.offset),
          data: Buffer.from(range.dataBase64 ?? range.data ?? '', range.dataBase64 ? 'base64' : 'utf8'),
        }));
        const result = await cache.derive(input.newKey, {
          baseKey: input.baseKey,
          expectedDigest: input.expectedDigest,
          ranges,
          overwrite: input.overwrite,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, ...result }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', message: 'unknown route' }));
    } catch (error) {
      const status = statusForError(error);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          code: (error as CacheError).code ?? 'SERVER_ERROR',
          message: (error as Error).message,
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ok: true,
      listening: `http://${host}:${actualPort}`,
      port: actualPort,
      dir: path.resolve(options.dir),
      quotaBytes: cache.quotaBytes,
    }),
  );

  const shutdown = () => {
    server.close(() => {
      void cache.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getFlag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dir = getFlag('dir') ?? process.env.LINKFORGE_CACHE_DIR ?? '.linkforge-cache';
  const port = Number(getFlag('port') ?? '4789');
  const host = getFlag('host') ?? '127.0.0.1';
  const quotaBytes = parseSize(getFlag('quota'), 9 * 1024 * 1024);
  await startServer({ dir, port, host, quotaBytes });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
