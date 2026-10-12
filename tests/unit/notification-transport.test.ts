import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, globalAgent, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retryDelay, sendNotification } from '../../apps/api/src/notification-worker.js';

let root: string;
let server: Server;
let origin: string;
let requests: { url: string; body: string; signature: string }[] = [];
const originalCA = globalAgent.options.ca;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'keel-webhook-tls-'));

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );

  const cert = await readFile(join(root, 'cert.pem'));

  globalAgent.options.ca = cert;

  server = createServer({ cert, key: await readFile(join(root, 'key.pem')) }, async (req, res) => {
    const parts = [];

    for await (const part of req) {
      parts.push(part);
    }

    requests.push({
      url: req.url!,
      body: Buffer.concat(parts).toString(),
      signature: String(req.headers['x-keel-signature']),
    });

    res.writeHead(req.url === '/redirect' ? 302 : 429, {
      Location: '/unexpected',
      'Retry-After': '90',
    });

    res.end('Never retain this private response.');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Missing HTTPS test address');
  }

  origin = `https://localhost:${address.port}`;
});

afterAll(async () => {
  globalAgent.options.ca = originalCA;
  server.closeAllConnections();

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  await rm(root, { recursive: true, force: true });
});

it('posts exact signed bytes over validated HTTPS, exposes headers only and never follows redirects', async () => {
  requests = [];
  const body = '{"event":"deployment.failed"}';

  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
    'x-keel-signature': 'sha256=fixture',
  };

  expect(await sendNotification(new URL(`${origin}/retry`), body, headers)).toEqual({
    status: 429,
    retryAfter: '90',
  });

  expect(await sendNotification(new URL(`${origin}/redirect`), body, headers)).toEqual({
    status: 302,
    retryAfter: '90',
  });

  expect(requests).toEqual([
    { url: '/retry', body, signature: 'sha256=fixture' },
    { url: '/redirect', body, signature: 'sha256=fixture' },
  ]);
});

it('rejects untrusted certificates', async () => {
  globalAgent.options.ca = originalCA;
  await expect(sendNotification(new URL(`${origin}/untrusted`), '{}', {})).rejects.toThrow();
});

it('bounds retries and handles numeric, date and malformed Retry-After values', () => {
  expect(retryDelay(1, '120')).toBe(120);
  expect(retryDelay(1, '999999999')).toBe(3600);
  expect(retryDelay(1, 'bad')).toBeGreaterThanOrEqual(30);
  expect(retryDelay(6)).toBeGreaterThanOrEqual(960);

  expect(retryDelay(1, 'Tue, 13 Oct 2026 00:02:00 GMT', Date.parse('2026-10-13T00:00:00Z'))).toBe(
    120,
  );
});
