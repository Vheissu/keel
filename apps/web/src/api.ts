import type { Snapshot } from '../../../packages/domain/src/index.js';

export type Dashboard = Snapshot & {
  totals: Record<string, number>;
  awaiting_approval: number;
  limit: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export class Api {
  // Intentionally memory-only: an API token is never persisted to browser storage.
  token = '';
  private pending: { fingerprint: string; key: string } | undefined;

  async request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
    const binary = body instanceof ArrayBuffer;

    if (method !== 'GET' && !key) {
      const content = binary
        ? Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', body as ArrayBuffer)),
            (b) => b.toString(16).padStart(2, '0'),
          ).join('')
        : JSON.stringify(body ?? {});

      const fingerprint = `${this.token}:${method}:${path}:${content}`;

      if (this.pending?.fingerprint !== fingerprint) {
        this.pending = { fingerprint, key: crypto.randomUUID() };
      }

      key = this.pending.key;
    }

    let requestBody: ArrayBuffer | string | undefined;

    if (method !== 'GET') {
      requestBody = binary ? body : JSON.stringify(body ?? {});
    }

    const response = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(method !== 'GET'
          ? {
              'Content-Type': binary ? 'application/octet-stream' : 'application/json',
              'Idempotency-Key': key!,
            }
          : {}),
      },
      body: requestBody,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);

      if (method !== 'GET' && response.status < 500) {
        this.pending = undefined;
      }

      throw new ApiError(
        data?.error?.message || `Request failed (${response.status}).`,
        response.status,
      );
    }

    const result = await response.json();

    if (method !== 'GET') {
      this.pending = undefined;
    }

    return result;
  }

  snapshot() {
    return this.request<Dashboard>('/snapshot');
  }

  async download(id: string): Promise<Blob> {
    const response = await fetch(`/api/v1/artifacts/${id}/download`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!response.ok) {
      throw new ApiError((await response.json()).error.message, response.status);
    }

    return response.blob();
  }
}
