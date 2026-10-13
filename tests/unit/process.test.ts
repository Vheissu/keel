import { describe, it, expect } from 'vitest';
import { parseProcess } from '../../packages/deployment-schema/src/index.js';
import { deploymentProcess } from '../fixtures.js';

describe('deployment process contract', () => {
  it('accepts the same canonical process as JSON and YAML', () => {
    const process = deploymentProcess();

    expect(parseProcess(JSON.stringify(process))).toEqual(parseProcess(process));
  });

  it('rejects build steps and arbitrary script execution', () => {
    const process = { ...deploymentProcess(), build: { command: 'npm run build' } };

    expect(() => parseProcess(process)).toThrow('Unrecognized key');
  });

  it('rejects unsupported strategies rather than implying traffic control', () => {
    const process = deploymentProcess();

    process.spec.environments.staging.strategy = 'canary';
    expect(() => parseProcess(process)).toThrow();
  });

  it.each(['//external.example/health', '/health#fragment', '/health\nheader', '/health check'])(
    'rejects unsafe HTTP verification path %j',
    (path) => {
      const process = deploymentProcess();

      Object.assign(process.spec.environments.staging, { verify: { http: { path } } });
      expect(() => parseProcess(process)).toThrow();
    },
  );

  it.each([
    '../app.tar',
    '/app.tar',
    'dir/../app.tar',
    'dir/./app.tar',
    'dir\\app.tar',
    '',
    'app.tar\n',
  ])('rejects unsafe ZIP archive path %j', (path) => {
    const process = deploymentProcess();

    Object.assign(process.spec.artifact, { dockerArchivePath: path });
    expect(() => parseProcess(process)).toThrow();
  });

  it('preserves a declared ZIP entry in the canonical process', () => {
    const process = deploymentProcess();

    Object.assign(process.spec.artifact, { dockerArchivePath: 'dist/application.tar' });
    expect(parseProcess(process).spec.artifact.dockerArchivePath).toBe('dist/application.tar');
  });

  it('accepts named environment secret references and rejects inline values and excess bindings', () => {
    const process = deploymentProcess();

    Object.assign(process.spec.environments.staging, {
      secrets: { APP_PASSWORD: { secret: 'DATABASE_PASSWORD' } },
    });

    expect(parseProcess(process).spec.environments.staging.secrets).toEqual({
      APP_PASSWORD: { secret: 'DATABASE_PASSWORD' },
    });

    for (const secrets of [
      { APP_PASSWORD: 'inline-value' },
      { APP_PASSWORD: { secret: 'DATABASE_PASSWORD', value: 'inline-value' } },
      { APP_PASSWORD: { secret: 'another-project/SECRET' } },
      { '--env': { secret: 'DATABASE_PASSWORD' } },
      Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [
          `SECRET_${index}`,
          { secret: 'DATABASE_PASSWORD' },
        ]),
      ),
    ]) {
      Object.assign(process.spec.environments.staging, { secrets });
      expect(() => parseProcess(process)).toThrow();
    }
  });

  it('rejects duplicate YAML keys, aliases, oversized documents and missing environments', () => {
    expect(() => parseProcess('kind: DeploymentProcess\nkind: DeploymentProcess')).toThrow(
      'Invalid YAML',
    );

    expect(() => parseProcess('a: &a [one, two]\nb: *a')).toThrow('Invalid YAML');
    expect(() => parseProcess('x'.repeat(64001))).toThrow('64 KB');
    const process = deploymentProcess();

    process.spec.environments = {} as typeof process.spec.environments;
    expect(() => parseProcess(process)).toThrow('At least one environment');
  });
});
