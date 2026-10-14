import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type Transaction } from '../../../packages/database/src/index.js';
import {
  DomainError,
  type Principal,
  type RunbookRun,
} from '../../../packages/domain/src/index.js';
import {
  CronError,
  nextCronOccurrence,
  normalizeTimeZone,
  parseCron,
} from '../../../packages/deployment-schema/src/index.js';
import type { ControlPlane } from './control-plane.js';
import { resolveRole } from './identity-policy.js';
import { assertScope, type RunbookPlan } from './runbooks.js';

const uuid = z.string().uuid();

export const runbookScheduleInput = z
  .object({
    runbook_plan_id: uuid,
    name: z.string().trim().min(1).max(100),
    cron: z.string().trim().min(9).max(100),
    time_zone: z.string().min(1).max(64),
    acknowledge_external_effects: z.literal(true),
  })
  .strict();

export const runbookScheduleState = z
  .object({ enabled: z.boolean(), expected_revision: z.number().int().positive() })
  .strict();

export interface RunbookSchedule {
  id: string;
  organisation_id: string;
  project_id: string;
  environment_id: string;
  runbook_id: string;
  runbook_version_id: string;
  source_plan_id: string;
  name: string;
  cron: string;
  time_zone: string;
  created_by: string;
  enabled: boolean;
  revision: number;
  next_run_at: Date | null;
  paused_code: string | null;
  created_at: Date;
}

// An occurrence more than this late (for example, while the worker was stopped) is skipped
// rather than run, so a restart never releases a burst of overdue tasks.
export const missedOccurrenceMs = 5 * 60_000;

// These outcomes need a person to create a new review; anything else skips one occurrence.
const pausingCodes = new Set([
  'INSTALLATION_RESTORED',
  'SCHEDULE_OWNER_ACCESS_CHANGED',
  'STALE_RUNBOOK_SCHEDULE',
  'SECRET_UNAVAILABLE',
  'NOT_FOUND',
  'SCHEDULE_ENDED',
]);

const stale = () =>
  new DomainError(
    'STALE_RUNBOOK_SCHEDULE',
    'The target, policy or secret versions changed after this schedule was reviewed. Create a new schedule from a fresh review.',
    409,
  );

function schedule(cron: string, timeZone: string) {
  const zone = normalizeTimeZone(timeZone);

  if (!zone) {
    throw new DomainError(
      'INVALID_SCHEDULE',
      'Use an IANA time zone such as UTC or Australia/Brisbane.',
    );
  }

  try {
    return { expression: cron.split(/\s+/).join(' '), parsed: parseCron(cron), zone };
  } catch (error) {
    if (error instanceof CronError) {
      throw new DomainError('INVALID_SCHEDULE', error.message);
    }

    throw error;
  }
}

function owner(s: RunbookSchedule): Principal {
  return {
    organisation_id: s.organisation_id,
    actor_id: s.created_by,
    name: 'Runbook schedule',
    permissions: ['read', 'write'],
    project_ids: null,
    environment_ids: null,
  };
}

export class RunbookSchedules {
  constructor(private control: ControlPlane) {}

  async create(
    tx: Transaction,
    p: Principal,
    input: z.infer<typeof runbookScheduleInput>,
    now = new Date(),
  ) {
    const { expression, parsed, zone } = schedule(input.cron, input.time_zone);

    const { plan, checked } = await this.control.runbooks.reviewedPlan(
      tx,
      p,
      input.runbook_plan_id,
    );

    const next = nextCronOccurrence(parsed, zone, now);

    if (!next) {
      throw new DomainError('INVALID_SCHEDULE', 'This schedule never runs.');
    }

    const created = (
      await tx.query<RunbookSchedule>(
        `
          INSERT INTO
            runbook_schedules (
              id,
              organisation_id,
              project_id,
              environment_id,
              runbook_id,
              runbook_version_id,
              source_plan_id,
              name,
              cron,
              time_zone,
              created_by,
              next_run_at
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING
            *
        `,
        [
          randomUUID(),
          p.organisation_id,
          plan.project_id,
          plan.environment_id,
          checked.version.runbook_id,
          plan.runbook_version_id,
          plan.id,
          input.name,
          expression,
          zone,
          p.actor_id,
          next,
        ],
      )
    ).rows[0];

    await this.control.audit(tx, p, 'runbook.schedule_created', created.id, {
      project_id: plan.project_id,
      environment_id: plan.environment_id,
      runbook_version_id: plan.runbook_version_id,
      runbook_plan_id: plan.id,
      target_id: plan.target_id,
      cron: expression,
      time_zone: zone,
      input_values: plan.input_values,
      secret_bindings: plan.secret_bindings,
      requires_approval: plan.requires_approval,
      next_run_at: next,
      acknowledge_external_effects: true,
    });

    return created;
  }

  async setState(
    tx: Transaction,
    p: Principal,
    id: string,
    input: z.infer<typeof runbookScheduleState>,
    now = new Date(),
  ) {
    const current = (
      await tx.query<RunbookSchedule>(
        'SELECT * FROM runbook_schedules WHERE organisation_id=$1 AND id=$2 FOR UPDATE',
        [p.organisation_id, id],
      )
    ).rows[0];

    if (!current) {
      throw new DomainError('NOT_FOUND', 'Runbook schedule not found.', 404);
    }

    assertScope(p, current);

    if (current.revision !== input.expected_revision) {
      throw new DomainError(
        'RUNBOOK_SCHEDULE_CHANGED',
        'The schedule changed. Refresh and try again.',
        409,
      );
    }

    let next: Date | null = null;

    if (input.enabled) {
      // Scheduled runs are requested in the creator's name, so only they can resume one.
      if (current.created_by !== p.actor_id) {
        throw new DomainError(
          'SCHEDULE_OWNER_REQUIRED',
          'Only the person who created this schedule can resume it. Create your own schedule from a new review.',
          403,
        );
      }

      if (await this.restored(tx, current)) {
        throw stale();
      }

      await this.matchingSource(tx, current);
      next = nextCronOccurrence(parseCron(current.cron), current.time_zone, now);

      if (!next) {
        throw new DomainError('INVALID_SCHEDULE', 'This schedule never runs.');
      }
    }

    const updated = (
      await tx.query<RunbookSchedule>(
        `
          UPDATE runbook_schedules
          SET
            enabled = $3,
            next_run_at = $4,
            paused_code = CASE
              WHEN $3 THEN NULL
              ELSE paused_code
            END,
            revision = revision + 1,
            updated_at = clock_timestamp()
          WHERE
            organisation_id = $1
            AND id = $2
          RETURNING
            *
        `,
        [p.organisation_id, id, input.enabled, next],
      )
    ).rows[0];

    await this.control.audit(
      tx,
      p,
      input.enabled ? 'runbook.schedule_enabled' : 'runbook.schedule_disabled',
      id,
      {
        project_id: current.project_id,
        environment_id: current.environment_id,
        next_run_at: next,
      },
    );

    return updated;
  }

  // Processes due schedules one transaction at a time, so a failure only affects its schedule.
  async runDue(now = new Date(), limit = 25) {
    let processed = 0;

    while (processed < limit) {
      const worked = await transaction(this.control.db, async (tx) => {
        const due = (
          await tx.query<RunbookSchedule>(
            `
              SELECT
                *
              FROM
                runbook_schedules
              WHERE
                enabled
                AND next_run_at <= $1
              ORDER BY
                next_run_at,
                id
              LIMIT
                1
              FOR UPDATE
                SKIP LOCKED
            `,
            [now],
          )
        ).rows[0];

        if (!due) {
          return false;
        }

        await this.occur(tx, due, now);

        return true;
      });

      if (!worked) {
        break;
      }

      processed += 1;
    }

    return processed;
  }

  private async occur(tx: Transaction, s: RunbookSchedule, now: Date) {
    const scheduledFor = new Date(s.next_run_at!);
    let code = 'RUN_REQUESTED';
    let run: RunbookRun | null = null;

    await tx.query('SAVEPOINT runbook_schedule');

    try {
      if (await this.restored(tx, s)) {
        code = 'INSTALLATION_RESTORED';
      } else if (!(await this.ownerCanWrite(tx, s))) {
        code = 'SCHEDULE_OWNER_ACCESS_CHANGED';
      } else if (now.getTime() - scheduledFor.getTime() > missedOccurrenceMs) {
        code = 'SCHEDULE_MISSED';
      } else {
        run = await this.start(tx, s, scheduledFor);
      }

      await tx.query('RELEASE SAVEPOINT runbook_schedule');
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT runbook_schedule');

      // A concurrent request can take the environment lock after the check in start().
      const lockTaken =
        (error as { constraint?: string }).constraint === 'deployment_environment_lock';

      if (error instanceof DomainError) {
        code = error.code;
      } else {
        code = lockTaken ? 'ENVIRONMENT_BUSY' : 'SCHEDULE_FAILED';
      }
    }

    let next: Date | null = null;

    if (!pausingCodes.has(code)) {
      next = nextCronOccurrence(
        parseCron(s.cron),
        s.time_zone,
        new Date(Math.max(now.getTime(), scheduledFor.getTime())),
      );

      code = next ? code : 'SCHEDULE_ENDED';
    }

    const paused = pausingCodes.has(code);

    await tx.query(
      `
        UPDATE runbook_schedules
        SET
          enabled = $3,
          next_run_at = $4,
          paused_code = $5,
          last_scheduled_for = $6,
          last_result_code = $7,
          last_run_id = coalesce($8, last_run_id),
          revision = revision + CASE
            WHEN $3 THEN 0
            ELSE 1
          END,
          updated_at = clock_timestamp()
        WHERE
          organisation_id = $1
          AND id = $2
      `,
      [
        s.organisation_id,
        s.id,
        !paused,
        paused ? null : next,
        paused ? code : null,
        scheduledFor,
        code,
        run?.id ?? null,
      ],
    );

    if (!run) {
      await this.control.audit(
        tx,
        owner(s),
        paused ? 'runbook.schedule_paused' : 'runbook.schedule_skipped',
        s.id,
        {
          project_id: s.project_id,
          environment_id: s.environment_id,
          code,
          scheduled_for: scheduledFor,
        },
      );
    }
  }

  private async start(tx: Transaction, s: RunbookSchedule, scheduledFor: Date) {
    const p = owner(s);
    const source = await this.matchingSource(tx, s);
    const { plan, checked } = source;

    const busy = await tx.query(
      `
        SELECT
          1
        FROM
          deployments
        WHERE
          organisation_id = $1
          AND project_id = $2
          AND environment_id = $3
          AND status IN (
            'awaiting_approval',
            'queued',
            'running',
            'cancel_requested',
            'reconciliation_required'
          )
      `,
      [s.organisation_id, s.project_id, s.environment_id],
    );

    if (busy.rowCount) {
      throw new DomainError('ENVIRONMENT_BUSY', 'The environment has an active request.', 409);
    }

    // The occurrence keeps the reviewed values and the target fence at admission, so the
    // ordinary assignment check still catches target changes before the task is dispatched.
    const occurrence = (
      await tx.query<RunbookPlan>(
        `
          INSERT INTO
            runbook_plans (
              id,
              organisation_id,
              project_id,
              environment_id,
              runbook_version_id,
              target_id,
              expected_fence,
              policy_revision,
              requires_approval,
              secret_bindings,
              created_by,
              input_values,
              schedule_id,
              scheduled_for
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING
            *
        `,
        [
          randomUUID(),
          s.organisation_id,
          s.project_id,
          s.environment_id,
          s.runbook_version_id,
          plan.target_id,
          checked.target.fence,
          plan.policy_revision,
          plan.requires_approval,
          JSON.stringify(plan.secret_bindings),
          s.created_by,
          plan.input_values,
          s.id,
          scheduledFor,
        ],
      )
    ).rows[0];

    return this.control.runbooks.admit(tx, p, occurrence, checked, {
      runbook_schedule_id: s.id,
      scheduled_for: scheduledFor,
      input_values: plan.input_values,
      secret_bindings: plan.secret_bindings,
    });
  }

  private async matchingSource(tx: Transaction, s: RunbookSchedule) {
    const plan = (
      await tx.query<RunbookPlan>(
        'SELECT * FROM runbook_plans WHERE organisation_id=$1 AND id=$2',
        [s.organisation_id, s.source_plan_id],
      )
    ).rows[0];

    // Deployments and earlier runs advance the target fence, so schedules do not pin it.
    const checked = await this.control.runbooks.matchingPlan(tx, owner(s), plan, {
      pinFence: false,
    });

    if (!checked) {
      throw stale();
    }

    return { plan, checked };
  }

  private async restored(tx: Transaction, s: RunbookSchedule) {
    const result = await tx.query(
      `
        SELECT
          1
        FROM
          audit_events
        WHERE
          organisation_id = $1
          AND action = 'installation.restored'
          AND created_at > $2
        LIMIT
          1
      `,
      [s.organisation_id, s.created_at],
    );

    return !!result.rowCount;
  }

  // Workspace members keep a schedule running while their role allows writes. Bootstrap actors
  // need an unrevoked write token that covers the schedule's project and environment.
  private async ownerCanWrite(tx: Transaction, s: RunbookSchedule) {
    const row = (
      await tx.query(
        `
          SELECT
            m.actor_id IS NOT NULL AS member,
            m.role,
            m.removed_at,
            EXISTS (
              SELECT
                1
              FROM
                api_tokens t
              WHERE
                t.organisation_id = $1
                AND t.actor_id = $2
                AND t.user_id IS NULL
                AND t.revoked_at IS NULL
                AND (
                  t.expires_at IS NULL
                  OR t.expires_at > now()
                )
                AND 'write' = ANY (t.permissions)
                AND (
                  t.project_ids IS NULL
                  OR $3 = ANY (t.project_ids)
                )
                AND (
                  t.environment_ids IS NULL
                  OR $4 = ANY (t.environment_ids)
                )
            ) AS token_write
          FROM
            (
              SELECT
                1
            ) one
            LEFT JOIN memberships m ON m.organisation_id = $1
            AND m.actor_id = $2
        `,
        [s.organisation_id, s.created_by, s.project_id, s.environment_id],
      )
    ).rows[0];

    if (!row.member) {
      return row.token_write as boolean;
    }

    if (row.removed_at) {
      return false;
    }

    try {
      return (await resolveRole(tx, s.organisation_id, row.role)).includes('write');
    } catch (error) {
      if (error instanceof DomainError) {
        return false;
      }

      throw error;
    }
  }
}
