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

    process.spec.environments.staging.strategy = 'blue-green';
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
