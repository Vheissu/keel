import { createHmac, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { transaction, type Database } from '../../../packages/database/src/index.js';
import type { CredentialVault } from './credential-vault.js';
import {
  notificationOrigins,
  notificationVault,
  validateNotificationUrl,
} from './notifications.js';

export interface NotificationResult {
  status: number;
  retryAfter?: string;
}

export type NotificationTransport = (
  url: URL,
  body: string,
  headers: Record<string, string>,
) => Promise<NotificationResult>;

export const sendNotification: NotificationTransport = (url, body, headers) =>
  new Promise((resolve, reject) => {
    // HTTPS only, normal certificate validation, no redirects, no response-body retention.
    const req = request(
      url,
      { method: 'POST', headers, signal: AbortSignal.timeout(10_000) },
      (res) => {
        resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] });
        res.destroy();
      },
    );

    req.on('error', reject);
    req.end(body);
  });

export function retryDelay(attempt: number, retryAfter?: string, now = Date.now()) {
  const base = Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 7));

  let requested = 0;

  if (retryAfter) {
    requested = /^\d+$/.test(retryAfter)
      ? Number(retryAfter)
      : (Date.parse(retryAfter) - now) / 1000;
  }

  return Math.min(
    3600,
    Math.max(
      base + Math.floor(Math.random() * base * 0.2),
      Number.isFinite(requested) ? requested : 0,
    ),
  );
}

interface ClaimedDelivery {
  id: string;
  organisation_id: string;
  endpoint_id: string;
  payload: Record<string, unknown>;
  credentials: unknown;
  enabled: boolean;
  status: string;
  attempt_count: number;
  cycle_attempts: number;
}

export class NotificationWorker {
  constructor(
    private db: Database,
    private vault: CredentialVault | undefined = notificationVault(),
    private transport: NotificationTransport = sendNotification,
    private origins: string[] = notificationOrigins(),
  ) {}

  async runOnce() {
    const job = await transaction(this.db, async (tx) => {
      const row = (
        await tx.query<ClaimedDelivery>(`
          SELECT
            d.*,
            n.enabled,
            n.credentials
          FROM
            notification_deliveries d
            JOIN notification_endpoints n ON n.organisation_id = d.organisation_id
            AND n.id = d.endpoint_id
          WHERE
            (
              d.status IN ('pending', 'retrying')
              AND d.next_attempt_at <= now()
            )
            OR (
              d.status = 'sending'
              AND d.lease_expires_at <= now()
            )
          ORDER BY
            d.next_attempt_at,
            d.id
          LIMIT
            1
          FOR UPDATE OF
            d SKIP LOCKED
        `)
      ).rows[0];

      if (!row) {
        return null;
      }

      if (row.status === 'sending') {
        await tx.query(
          `
            UPDATE notification_attempts
            SET
              code = 'LEASE_EXPIRED',
              completed_at = now()
            WHERE
              delivery_id = $1
              AND completed_at IS NULL
          `,
          [row.id],
        );
      }

      if (!row.enabled || row.cycle_attempts >= 6) {
        await tx.query(
          `
            UPDATE notification_deliveries
            SET
              status = $2,
              last_code = $3,
              lease_id = NULL,
              lease_expires_at = NULL
            WHERE
              id = $1
          `,
          [
            row.id,
            row.enabled ? 'failed' : 'cancelled',
            row.enabled ? 'ATTEMPTS_EXHAUSTED' : 'DESTINATION_DISABLED',
          ],
        );

        return { settled: true as const };
      }

      const lease = randomUUID();
      const attempt = row.attempt_count + 1;

      await tx.query(
        `
          UPDATE notification_deliveries
          SET
            status = 'sending',
            lease_id = $2,
            lease_expires_at = now() + interval '45 seconds',
            attempt_count = $3,
            cycle_attempts = cycle_attempts + 1
          WHERE
            id = $1
        `,
        [row.id, lease, attempt],
      );

      await tx.query(
        `
          INSERT INTO
            notification_attempts (id, organisation_id, delivery_id, attempt)
          VALUES
            ($1, $2, $3, $4)
        `,
        [lease, row.organisation_id, row.id, attempt],
      );

      return { ...row, lease, attempt, cycle: row.cycle_attempts + 1, settled: false };
    });

    if (!job) {
      return false;
    }

    if (job.settled) {
      return true;
    }

    let code = 'NETWORK_ERROR';
    let httpStatus: number | null = null;
    let retryAfter: string | undefined;
    let retryable = true;

    try {
      if (!this.vault) {
        throw new Error('Missing vault');
      }

      const credentials = this.vault.decrypt<{ url: string; secret: string }>(
        job.organisation_id,
        job.endpoint_id,
        job.credentials,
      );

      const url = validateNotificationUrl(credentials.url, this.origins);
      const body = JSON.stringify(job.payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const signature = createHmac('sha256', credentials.secret)
        .update(`${timestamp}.${job.id}.${body}`)
        .digest('hex');

      const response = await this.transport(url, body, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body).toString(),
        'user-agent': 'Keel-Notifications/1',
        'x-keel-delivery': job.id,
        'x-keel-timestamp': timestamp,
        'x-keel-signature': `sha256=${signature}`,
      });

      httpStatus = response.status;
      retryAfter = response.retryAfter;
      code = httpStatus >= 200 && httpStatus < 300 ? 'ACCEPTED' : 'HTTP_ERROR';
      retryable = httpStatus >= 500 || [408, 425, 429].includes(httpStatus);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['INVALID_DESTINATION', 'CREDENTIAL_UNAVAILABLE'].includes(String(error.code))
      ) {
        code = String(error.code);
        retryable = false;
      } else if (!this.vault) {
        code = 'CREDENTIAL_UNAVAILABLE';
        retryable = false;
      }
    }

    let status = 'failed';

    if (code === 'ACCEPTED') {
      status = 'delivered';
    } else if (retryable && job.cycle < 6) {
      status = 'retrying';
    }

    await transaction(this.db, async (tx) => {
      // A timed-out worker must never overwrite a replacement worker's result.
      const result = await tx.query(
        `
          UPDATE notification_deliveries
          SET
            status = $3,
            last_code = $4,
            last_http_status = $5,
            next_attempt_at = now() + ($6 * interval '1 second'),
            lease_id = NULL,
            lease_expires_at = NULL,
            delivered_at = CASE
              WHEN $3 = 'delivered' THEN now()
              ELSE NULL
            END
          WHERE
            id = $1
            AND lease_id = $2
            AND status = 'sending'
            AND lease_expires_at > now()
          RETURNING
            id
        `,
        [job.id, job.lease, status, code, httpStatus, retryDelay(job.cycle, retryAfter)],
      );

      if (result.rowCount) {
        await tx.query(
          `
            UPDATE notification_attempts
            SET
              code = $2,
              http_status = $3,
              completed_at = now()
            WHERE
              id = $1
          `,
          [job.lease, code, httpStatus],
        );
      }
    });

    return true;
  }
}
