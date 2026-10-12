import type { Snapshot } from '../../../packages/domain/src/index.js';
import { sha256Hex } from './format';

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
  // Called when the current token is rejected, so every caller ends the session the same way.
  onUnauthorized: ((error: ApiError) => void) | null = null;
  // Idempotency keys for in-flight writes. A request retried after a network error or 5xx reuses its key.
  private pending = new Map<string, string>();

  /** `bodyDigest` is the SHA-256 hex of a binary body, when the caller has already computed it. */
  async request<T>(path: string, method = 'GET', body?: unknown, bodyDigest?: string): Promise<T> {
    const token = this.token;
    const binary = body instanceof ArrayBuffer;
    let fingerprint = '';
    let key = '';

    if (method !== 'GET') {
      const content = binary
        ? (bodyDigest ?? (await sha256Hex(body as ArrayBuffer)))
        : JSON.stringify(body ?? {});

      // Hash the fingerprint so request bodies such as secret values are not kept in memory.
      fingerprint = await sha256Hex(
        new TextEncoder().encode(`${token}:${method}:${path}:${content}`),
      );

      key = this.pending.get(fingerprint) ?? crypto.randomUUID();
      this.pending.set(fingerprint, key);
    }

    let requestBody: ArrayBuffer | string | undefined;

    if (method !== 'GET') {
      requestBody = binary ? body : JSON.stringify(body ?? {});
    }

    const response = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method !== 'GET'
          ? {
              'Content-Type': binary ? 'application/octet-stream' : 'application/json',
              'Idempotency-Key': key,
            }
          : {}),
      },
      body: requestBody,
    });

    if (!response.ok) {
      if (fingerprint && response.status < 500) {
        this.pending.delete(fingerprint);
      }

      throw await this.failure(response, token);
    }

    const result = await response.json();

    if (fingerprint) {
      this.pending.delete(fingerprint);
    }

    return result;
  }

  snapshot() {
    return this.request<Dashboard>('/snapshot');
  }

  async download(id: string): Promise<Blob> {
    const token = this.token;

    const response = await fetch(`/api/v1/artifacts/${id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw await this.failure(response, token);
    }

    return response.blob();
  }

  private async failure(response: Response, token: string) {
    const data = await response.json().catch(() => null);

    const error = new ApiError(
      data?.error?.message || `Request failed (${response.status}).`,
      response.status,
    );

    // Ignore a late rejection for a token the user has already replaced.
    if (response.status === 401 && token === this.token) {
      this.onUnauthorized?.(error);
    }

    return error;
  }
}
