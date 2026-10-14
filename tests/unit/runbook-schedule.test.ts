import { expect, it } from 'vitest';
import {
  cronOccurrences,
  normalizeTimeZone,
  parseCron,
} from '../../packages/deployment-schema/src/index.js';

const next = (expression: string, timeZone: string, after: string, count = 3) =>
  cronOccurrences(expression, timeZone, new Date(after), count).map((date) => date.toISOString());

it('evaluates wall-clock times in the schedule time zone', () => {
  expect(next('30 9 * * 1-5', 'Australia/Brisbane', '2026-10-15T23:30:00Z', 3)).toEqual([
    '2026-10-18T23:30:00.000Z',
    '2026-10-19T23:30:00.000Z',
    '2026-10-20T23:30:00.000Z',
  ]);

  expect(next('0 0 * * 0', 'UTC', '2026-10-14T00:00:00Z', 1)).toEqual(
    next('0 0 * * 7', 'UTC', '2026-10-14T00:00:00Z', 1),
  );
});

it('skips wall times removed by daylight saving and runs repeated times once', () => {
  expect(next('30 2 * * *', 'America/New_York', '2026-03-07T00:00:00Z')).toEqual([
    '2026-03-07T07:30:00.000Z',
    '2026-03-09T06:30:00.000Z',
    '2026-03-10T06:30:00.000Z',
  ]);

  expect(next('30 1 * * *', 'America/New_York', '2026-10-31T12:00:00Z')).toEqual([
    '2026-11-01T05:30:00.000Z',
    '2026-11-02T06:30:00.000Z',
    '2026-11-03T06:30:00.000Z',
  ]);

  // Starting during the repeated hour does not run 01:30 a second time.
  expect(next('30 1 * * *', 'America/New_York', '2026-11-01T06:10:00Z', 1)).toEqual([
    '2026-11-02T06:30:00.000Z',
  ]);
});

it('matches either restricted day field, and both when one starts with *', () => {
  expect(next('0 0 1,15 * 1', 'UTC', '2026-10-14T00:00:00Z', 4)).toEqual([
    '2026-10-15T00:00:00.000Z',
    '2026-10-19T00:00:00.000Z',
    '2026-10-26T00:00:00.000Z',
    '2026-11-01T00:00:00.000Z',
  ]);

  expect(next('0 0 */2 * 1', 'UTC', '2026-10-14T00:00:00Z', 2)).toEqual([
    '2026-10-19T00:00:00.000Z',
    '2026-11-09T00:00:00.000Z',
  ]);
});

it('finds rare dates and reports schedules that never run', () => {
  expect(next('0 0 29 2 *', 'UTC', '2026-10-14T00:00:00Z', 2)).toEqual([
    '2028-02-29T00:00:00.000Z',
    '2032-02-29T00:00:00.000Z',
  ]);

  expect(next('0 0 31 2 *', 'UTC', '2026-10-14T00:00:00Z')).toEqual([]);
  expect(next('0 0 * * *', 'UTC', '2026-10-14T00:00:30Z', 1)).toEqual(['2026-10-15T00:00:00.000Z']);
});

it('rejects malformed fields and schedules more frequent than five minutes', () => {
  for (const expression of [
    '* * * * *',
    '0,4 * * * *',
    '0,57 * * * *',
    '*/4 * * * *',
    '60 * * * *',
    '0 0 0 * *',
    '0 0 * 13 *',
    '0 0 * * 8',
    '5-1 * * * *',
    '*/0 * * * *',
    '0 0 * *',
    '0 0 * * * *',
    'MON 0 * * *',
    '0 0 * * MON',
    '1/2/3 * * * *',
  ]) {
    expect(() => parseCron(expression), expression).toThrow();
  }

  expect(parseCron('0,5,55 * * * *').minutes).toEqual([0, 5, 55]);
  expect(parseCron('*/5 * * * *').minutes).toHaveLength(12);
  expect(parseCron('10/20 * * * *').minutes).toEqual([10, 30, 50]);
});

it('accepts canonical IANA zones only', () => {
  expect(normalizeTimeZone('UTC')).toBe('UTC');
  expect(normalizeTimeZone('Australia/Brisbane')).toBe('Australia/Brisbane');

  for (const zone of ['Mars/Olympus', '../UTC', '+10:00', '', 'A'.repeat(65)]) {
    expect(normalizeTimeZone(zone), zone).toBeNull();
  }
});
