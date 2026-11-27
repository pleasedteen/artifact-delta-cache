import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { startServer } from '../server.js';
import { makeTempDir } from './helpers.js';

test('HTTP interface stores, derives, verifies, restores, and reports occupancy', async (t) => {
  const root = await makeTempDir('linkforge-http-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const server = await startServer({
    dir: path.join(root, 'cache'),
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 4 * 1024 * 1024,
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const base = crypto.randomBytes(128 * 1024);
  const putResponse = await fetch(`${baseUrl}/v1/keys?key=base`, {
    method: 'PUT',
    body: base,
  });
  assert.equal(putResponse.status, 200);

  const patch = crypto.randomBytes(16 * 1024);
  const offset = 1234;
  const expected = Buffer.from(base);
  patch.copy(expected, offset);
  const expectedDigest = crypto.createHash('sha256').update(expected).digest('hex');

  const deriveResponse = await fetch(`${baseUrl}/v1/derive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      newKey: 'child',
      baseKey: 'base',
      expectedDigest,
      ranges: [{ offset, dataBase64: patch.toString('base64') }],
    }),
  });
  assert.equal(deriveResponse.status, 200, await deriveResponse.text());

  const getResponse = await fetch(`${baseUrl}/v1/keys?key=child`);
  assert.equal(getResponse.status, 200);
  const body = Buffer.from(await getResponse.arrayBuffer());
  assert.deepEqual(body, expected);
  assert.equal(getResponse.headers.get('x-digest'), expectedDigest);

  const statsResponse = await fetch(`${baseUrl}/v1/stats`);
  const stats = await statsResponse.json() as { ok: boolean; keyCount: number; occupiedBytes: number };
  assert.equal(stats.ok, true);
  assert.equal(stats.keyCount, 2);
  assert.ok(stats.occupiedBytes > 0);

  const deleteResponse = await fetch(`${baseUrl}/v1/keys?key=base`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json() as { existed: boolean }).existed, true);
});
