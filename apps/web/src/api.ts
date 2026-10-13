import type { Snapshot } from '../../../packages/domain/src/index.js';
import { sha256Hex } from './format';

export type Dashboard = Snapshot & {
  totals: Record<string, number>;
  awaiting_approval: number;
  limit: number;
  integrations_configured: boolean;
  environment_states: {
    project_id: string;
    environment_slug: string;
    release_version: string;
    status: string;
  }[];
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
  workspaceId = '';
  csrf = '';

  identity() {
    return `${this.token}:${this.workspaceId}:${this.csrf}`;
  }

  headers() {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(this.workspaceId ? { 'X-Workspace-ID': this.workspaceId } : {}),
      ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
    };
  }

  async auth<T>(path: string, body?: unknown): Promise<T> {
    const identity = this.identity();

    const response = await fetch(`/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const result = await response.json();

    if (!response.ok) {
      const error = new ApiError(
        result.error?.message || 'Account request failed.',
        response.status,
      );

      if (
        response.status === 401 &&
        path !== '/login' &&
        this.csrf &&
        identity === this.identity()
      ) {
        this.onUnauthorized?.(error);
      }

      throw error;
    }

    return result;
  }

  // Called when the current token is rejected, so every caller ends the session the same way.
  onUnauthorized: ((error: ApiError) => void) | null = null;
  // Idempotency keys for in-flight writes. A request retried after a network error or 5xx reuses its key.
  private pending = new Map<string, string>();

  /** `bodyDigest` is the SHA-256 hex of a binary body, when the caller has already computed it. */
  async request<T>(path: string, method = 'GET', body?: unknown, bodyDigest?: string): Promise<T> {
    const identity = this.identity();
    const headers = this.headers();
    const binary = body instanceof ArrayBuffer;
    let fingerprint = '';
    let key = '';

    if (method !== 'GET') {
      const content = binary
        ? (bodyDigest ?? (await sha256Hex(body as ArrayBuffer)))
        : JSON.stringify(body ?? {});

      // Hash the fingerprint so request bodies such as secret values are not kept in memory.
      fingerprint = await sha256Hex(
        new TextEncoder().encode(`${identity}:${method}:${path}:${content}`),
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
        ...headers,
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

      throw await this.failure(response, identity);
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
    const identity = this.identity();
    const headers = this.headers();

    const response = await fetch(`/api/v1/artifacts/${id}/download`, {
      headers,
    });

    if (!response.ok) {
      throw await this.failure(response, identity);
    }

    return response.blob();
  }

  private async failure(response: Response, identity: string) {
    const data = await response.json().catch(() => null);

    const error = new ApiError(
      data?.error?.message || `Request failed (${response.status}).`,
      response.status,
    );

    // Ignore a late rejection after the user changes credentials or workspace.
    if (response.status === 401 && identity === this.identity()) {
      this.onUnauthorized?.(error);
    }

    return error;
  }
}
