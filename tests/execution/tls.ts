import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

const run = promisify(execFile);

export async function certificates(root: string) {
  const file = (name: string) => join(root, name);

  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('ca.key'),
    '-out',
    file('ca.crt'),
    '-days',
    '1',
    '-subj',
    '/CN=Keel test CA',
  ]);

  for (const name of ['server', 'client', 'unknown']) {
    await run('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file(`${name}.key`),
      '-out',
      file(`${name}.csr`),
      '-subj',
      `/CN=${name}`,
    ]);

    await writeFile(
      file(`${name}.ext`),
      name === 'server'
        ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'
        : 'extendedKeyUsage=clientAuth\n',
    );

    await run('openssl', [
      'x509',
      '-req',
      '-in',
      file(`${name}.csr`),
      '-CA',
      file('ca.crt'),
      '-CAkey',
      file('ca.key'),
      '-CAcreateserial',
      '-out',
      file(`${name}.crt`),
      '-days',
      '1',
      '-extfile',
      file(`${name}.ext`),
    ]);
  }

  const ca = await readFile(file('ca.crt'));

  const server = {
    ca,
    cert: await readFile(file('server.crt')),
    key: await readFile(file('server.key')),
  };

  const client = {
    ca,
    cert: await readFile(file('client.crt')),
    key: await readFile(file('client.key')),
  };

  const unknown = {
    ca,
    cert: await readFile(file('unknown.crt')),
    key: await readFile(file('unknown.key')),
  };

  return {
    file,
    server,
    client,
    unknown,
    fingerprint: new X509Certificate(client.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
  };
}
