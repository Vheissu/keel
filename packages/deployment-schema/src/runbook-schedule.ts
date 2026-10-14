// Five-field cron schedules evaluated in an IANA time zone. Numeric fields only: minute, hour,
// day of month, month and day of week (0 or 7 is Sunday).
export interface CronSchedule {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

export const minimumScheduleMinutes = 5;

const minute = 60_000;
const day = 86_400_000;
// Covers leap days that skip a century year, such as 29 February 2096 to 2104.
const horizonDays = 366 * 8 + 2;

const fields = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

export class CronError extends Error {}

function parseField(source: string, { name, min, max }: (typeof fields)[number]) {
  const values = new Set<number>();

  const number = (text: string) => {
    if (!/^\d{1,2}$/.test(text) || Number(text) < min || Number(text) > max) {
      throw new CronError(`The ${name} field must use whole numbers from ${min} to ${max}.`);
    }

    return Number(text);
  };

  for (const item of source.split(',')) {
    const [range, stepText, extra] = item.split('/');

    if (extra !== undefined || !range) {
      throw new CronError(`The ${name} field is not valid.`);
    }

    const step = stepText === undefined ? 1 : number(stepText);

    if (step < 1) {
      throw new CronError(`The ${name} field step must be at least 1.`);
    }

    let start: number;
    let end: number;

    if (range === '*') {
      [start, end] = [min, max];
    } else if (range.includes('-')) {
      const [from, to, rest] = range.split('-');

      if (rest !== undefined) {
        throw new CronError(`The ${name} field is not valid.`);
      }

      [start, end] = [number(from), number(to)];

      if (start > end) {
        throw new CronError(`The ${name} field ranges must run from low to high.`);
      }
    } else {
      start = number(range);
      end = stepText === undefined ? start : max;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return values;
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);

  if (expression.length > 100 || parts.length !== 5) {
    throw new CronError('Use five cron fields: minute, hour, day of month, month and day of week.');
  }

  const [minutes, hours, days, months, weekdays] = parts.map((part, index) =>
    parseField(part, fields[index]),
  );

  if (weekdays.delete(7)) {
    weekdays.add(0);
  }

  const sorted = [...minutes].sort((a, b) => a - b);

  // Cyclic spacing also covers the gap from the last minute in one hour to the first in the next.
  const tooClose = sorted.some((value, index) => {
    const next = index + 1 < sorted.length ? sorted[index + 1] : sorted[0] + 60;

    return next - value < minimumScheduleMinutes;
  });

  if (tooClose) {
    throw new CronError(`Schedules can run at most once every ${minimumScheduleMinutes} minutes.`);
  }

  return {
    minutes: sorted,
    hours: [...hours].sort((a, b) => a - b),
    days,
    months,
    weekdays,
    // As in Vixie cron, both day fields must match when either starts with *; otherwise either may.
    anyDay: parts[2].startsWith('*'),
    anyWeekday: parts[4].startsWith('*'),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let result = formatters.get(timeZone);

  if (!result) {
    result = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });

    formatters.set(timeZone, result);
  }

  return result;
}

// Returns the wall-clock time at an instant, expressed as a UTC timestamp of the same fields.
function wallClock(instant: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

// Wall times skipped by a daylight-saving change have no instant. Repeated wall times use the
// first occurrence, so a schedule runs once.
function instantAt(wall: number, timeZone: string): number | null {
  const offsets = new Set(
    [wall - day, wall, wall + day].map((probe) => wallClock(probe, timeZone) - probe),
  );

  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => wallClock(instant, timeZone) === wall)
    .sort((a, b) => a - b);

  return matches[0] ?? null;
}

export function normalizeTimeZone(value: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(value)) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function nextCronOccurrence(
  schedule: CronSchedule,
  timeZone: string,
  after: Date,
): Date | null {
  const from = Math.floor(after.getTime() / minute) * minute;
  const start = wallClock(from, timeZone);
  const first = Math.floor(start / day) * day;

  for (let date = first; date <= first + horizonDays * day; date += day) {
    const calendar = new Date(date);

    if (!schedule.months.has(calendar.getUTCMonth() + 1)) {
      continue;
    }

    const dayMatch = schedule.days.has(calendar.getUTCDate());
    const weekdayMatch = schedule.weekdays.has(calendar.getUTCDay());

    const matches =
      schedule.anyDay || schedule.anyWeekday ? dayMatch && weekdayMatch : dayMatch || weekdayMatch;

    if (!matches) {
      continue;
    }

    for (const hour of schedule.hours) {
      for (const value of schedule.minutes) {
        const wall = date + hour * 3_600_000 + value * minute;

        // Earlier wall times on the first day cannot follow `after`, allowing for offset changes.
        if (wall < start - 3 * 3_600_000) {
          continue;
        }

        const instant = instantAt(wall, timeZone);

        if (instant !== null && instant > after.getTime()) {
          return new Date(instant);
        }
      }
    }
  }

  return null;
}

export function cronOccurrences(
  expression: string,
  timeZone: string,
  after: Date,
  count: number,
): Date[] {
  const schedule = parseCron(expression);
  const zone = normalizeTimeZone(timeZone);
  const result: Date[] = [];

  if (!zone) {
    throw new CronError('Use an IANA time zone such as UTC or Australia/Brisbane.');
  }

  let cursor = after;

  while (result.length < count) {
    const next = nextCronOccurrence(schedule, zone, cursor);

    if (!next) {
      break;
    }

    result.push(next);
    cursor = next;
  }

  return result;
}
