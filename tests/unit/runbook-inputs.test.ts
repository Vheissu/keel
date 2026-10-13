import { describe, expect, it } from 'vitest';
import { parseRunbook, resolveRunbookInputs } from '../../packages/deployment-schema/src/index.js';

const process = (inputs: unknown, secrets?: unknown) => ({
  apiVersion: 'keel.dev/v1alpha1',
  kind: 'Runbook',
  spec: {
    artifact: { dockerImageId: `sha256:${'a'.repeat(64)}` },
    task: { command: ['/bin/task', '--fixed'], timeoutSeconds: 30 },
    inputs,
    ...(secrets ? { secrets } : {}),
  },
});

const definitions = () =>
  parseRunbook(
    process({
      LABEL: { type: 'string', minLength: 0, maxLength: 64, default: '' },
      LIMIT: { type: 'integer', minimum: -10, maximum: 10, default: 0 },
      APPLY: { type: 'boolean', default: false },
      REGION: { type: 'enum', choices: ['east', 'west'], default: 'east' },
    }),
  ).spec.inputs;

it('resolves defaults without losing false, zero or empty text', () => {
  expect(resolveRunbookInputs(definitions(), {})).toEqual({
    APPLY: false,
    LABEL: '',
    LIMIT: 0,
    REGION: 'east',
  });

  expect(
    resolveRunbookInputs(definitions(), {
      LABEL: 'literal $(touch /tmp/no) = "value"',
      LIMIT: -10,
      APPLY: true,
      REGION: 'west',
    }),
  ).toEqual({
    APPLY: true,
    LABEL: 'literal $(touch /tmp/no) = "value"',
    LIMIT: -10,
    REGION: 'west',
  });
});

it('requires every input that has no default and keeps legacy runbooks input-free', () => {
  const inputs = parseRunbook(process({ COUNT: { type: 'integer', minimum: 1, maximum: 4 } })).spec
    .inputs;

  expect(() => resolveRunbookInputs(inputs, {})).toThrow('COUNT is required');
  expect(resolveRunbookInputs(inputs, { COUNT: 1 })).toEqual({ COUNT: 1 });
  expect(resolveRunbookInputs(undefined, {})).toEqual({});
  expect(() => resolveRunbookInputs(undefined, { EXTRA: 'ignored?' })).toThrow('not declared');
});

describe('rejects values without coercion or silent truncation', () => {
  for (const values of [
    null,
    [],
    'text',
    { EXTRA: 'x' },
    { APPLY: 'false' },
    { APPLY: 0 },
    { LIMIT: '2' },
    { LIMIT: 2.5 },
    { LIMIT: 11 },
    { LIMIT: -11 },
    { LIMIT: Infinity },
    { LIMIT: NaN },
    { REGION: 'north' },
    { REGION: false },
    { LABEL: 2 },
    { LABEL: null },
    { LABEL: { nested: true } },
    { LABEL: ['x'] },
    { LABEL: 'x'.repeat(65) },
    { LABEL: 'bad\nline' },
    { LABEL: 'bad\0value' },
    { LABEL: '\ud800' },
    { LABEL: 'bad\tvalue' },
    { LABEL: 'bad\x7fvalue' },
  ]) {
    it(JSON.stringify(values), () => {
      expect(() => resolveRunbookInputs(definitions(), values)).toThrow();
    });
  }
});

it('enforces text lower bounds and preserves spaces and Unicode', () => {
  const inputs = parseRunbook(process({ TEXT: { type: 'string', minLength: 2, maxLength: 8 } }))
    .spec.inputs;

  expect(() => resolveRunbookInputs(inputs, { TEXT: '' })).toThrow();
  expect(() => resolveRunbookInputs(inputs, { TEXT: 'a' })).toThrow();
  expect(resolveRunbookInputs(inputs, { TEXT: '  café  ' })).toEqual({ TEXT: '  café  ' });
});

describe('rejects invalid input definitions at publication', () => {
  for (const input of [
    { type: 'string' },
    { type: 'string', maxLength: 257 },
    { type: 'string', minLength: 3, maxLength: 2 },
    { type: 'string', minLength: 1, maxLength: 2, default: '' },
    { type: 'string', maxLength: 2, default: 'abc' },
    { type: 'string', maxLength: 2, pattern: '.*' },
    { type: 'integer', minimum: 1 },
    { type: 'integer', minimum: 2, maximum: 1 },
    { type: 'integer', minimum: 0, maximum: 4, default: 5 },
    { type: 'integer', minimum: 0, maximum: 2147483648 },
    { type: 'integer', minimum: 0, maximum: 4, default: '2' },
    { type: 'boolean', default: 'false' },
    { type: 'enum', choices: [] },
    { type: 'enum', choices: ['a', 'a'] },
    { type: 'enum', choices: ['a'], default: 'b' },
    { type: 'enum', choices: [''] },
    { type: 'enum', choices: ['bad\nchoice'] },
    { type: 'enum', choices: Array.from({ length: 33 }, (_, n) => String(n)) },
    { type: 'secret' },
    { type: 'array' },
  ]) {
    it(JSON.stringify(input), () => {
      expect(() => parseRunbook(process({ VALUE: input }))).toThrow();
    });
  }
});

it('caps input count and names and prevents secret-variable collisions', () => {
  const many = Object.fromEntries(
    Array.from({ length: 17 }, (_, n) => [`INPUT_${n}`, { type: 'boolean' }]),
  );

  expect(() => parseRunbook(process(many))).toThrow();

  for (const name of ['lowercase', 'WITH SPACE', 'A=B', 'X'.repeat(49), '__proto__']) {
    expect(() => parseRunbook(process({ [name]: { type: 'boolean' } }))).toThrow();
  }

  expect(() =>
    parseRunbook(process({ KEY: { type: 'boolean' } }, { KEEL_INPUT_KEY: { secret: 'PASSWORD' } })),
  ).toThrow('conflicts');

  expect(
    parseRunbook(process({ KEY: { type: 'boolean' } }, { PASSWORD: { secret: 'PASSWORD' } })).spec
      .task.command,
  ).toEqual(['/bin/task', '--fixed']);
});
