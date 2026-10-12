import { z } from 'zod';
import { boundedResponse, ProviderError } from './provider-http.js';

export { boundedResponse, ProviderError } from './provider-http.js';

import {
  githubCapabilities,
  type CIProviderAdapter,
  type ExternalRun,
  type ProviderConnection,
} from './index.js';

export const githubRepository = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]));

export const externalId = z.string().regex(/^[1-9][0-9]{0,19}$/);

const githubId = z.number().int().positive().safe().transform(String);
const timestamp = z.iso.datetime({ offset: true });
const repository = z.object({ id: githubId, full_name: githubRepository });

const runSchema = z.object({
  id: githubId,
  workflow_id: githubId,
  run_attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  head_branch: z.string().nullable(),
  event: z.string(),
  run_started_at: timestamp,
  repository,
  head_repository: repository.nullable(),
});

const artifactSchema = z.object({
  id: githubId,
  name: z.string(),
  size_in_bytes: z.number().int().nonnegative(),
  expired: z.boolean(),
  expires_at: timestamp.nullable(),
  created_at: timestamp,
  digest: z.string().nullable().optional(),
  workflow_run: z.object({
    id: githubId,
    head_sha: z.string(),
    repository_id: githubId,
    head_repository_id: githubId,
  }),
});

export type GitHubCredentials = { token: string; repository: string };

export type GitHubArtifact = z.infer<typeof artifactSchema>;

export interface GitHubRun extends ExternalRun {
  attempt: number;
  repositoryId: string;
  headRepositoryId: string | null;
  branch: string | null;
  event: string;
  startedAt: string;
}

export class GitHubActionsAdapter implements CIProviderAdapter {
  constructor(
    private credentials: (connection: ProviderConnection) => Promise<GitHubCredentials>,
    private transport: typeof fetch = fetch,
  ) {}

  capabilities() {
    return { ...githubCapabilities };
  }

  private async request(connection: ProviderConnection, suffix = '') {
    const credentials = await this.credentials(connection);

    const repo = githubRepository
      .parse(credentials.repository)
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    let response: Response;

    try {
      response = await this.transport(`https://api.github.com/repos/${repo}${suffix}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${credentials.token}`,
          'X-GitHub-Api-Version': '2026-03-10',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'GitHub could not be reached. The import will retry.',
        true,
      );
    }

    if (response.ok || response.status === 302) {
      return response;
    }

    await response.body?.cancel();

    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.has('retry-after') ||
          response.headers.get('x-ratelimit-remaining') === '0'));

    if (limited) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset')) - Date.now() / 1000;
      const delay = Math.min(3600, Math.max(30, retryAfter || reset || 60));

      throw new ProviderError(
        'PROVIDER_RATE_LIMIT',
        'GitHub rate limited this connection. The import will retry.',
        true,
        delay,
      );
    }

    if ([401, 403].includes(response.status)) {
      throw new ProviderError(
        'PROVIDER_AUTH_FAILED',
        'GitHub denied access. Check or rotate the connection token.',
      );
    }

    if (response.status === 404 || response.status === 410) {
      throw new ProviderError(
        'PROVIDER_NOT_FOUND',
        'The GitHub repository, run or artifact is unavailable or expired.',
      );
    }

    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'GitHub could not complete the request.',
      response.status >= 500,
    );
  }

  private async json<T>(
    connection: ProviderConnection,
    suffix: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.request(connection, suffix);

    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(
        'PROVIDER_REDIRECT_REJECTED',
        'The repository moved. Reconnect it using its current name.',
      );
    }

    try {
      const bytes = await boundedResponse(response, 2 * 1024 * 1024, 'GitHub');

      return schema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError('PROVIDER_RESPONSE_INVALID', 'GitHub returned unexpected metadata.');
    }
  }

  async verifyConnection(connection: ProviderConnection, workflowId: string) {
    const repo = await this.json(connection, '', repository);

    const workflow = await this.json(
      connection,
      `/actions/workflows/${externalId.parse(workflowId)}`,
      z.object({ id: githubId }),
    );

    if (workflow.id !== workflowId) {
      throw new ProviderError('PROVIDER_RESPONSE_INVALID', 'GitHub returned a different workflow.');
    }

    return repo;
  }

  async listPipelines(connection: ProviderConnection) {
    const workflows = [];

    for (let page = 1; page <= 10; page++) {
      const result = await this.json(
        connection,
        `/actions/workflows?per_page=100&page=${page}`,
        z.object({
          workflows: z.array(z.object({ id: githubId, name: z.string() })),
        }),
      );

      workflows.push(
        ...result.workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          url: `https://github.com/${connection.repository}/actions/workflows/${workflow.id}`,
        })),
      );

      if (result.workflows.length < 100) {
        return workflows;
      }
    }

    throw new ProviderError(
      'PROVIDER_PAGE_LIMIT',
      'This repository exceeds the 1,000-workflow discovery limit.',
    );
  }

  async getRun(connection: ProviderConnection, runId: string): Promise<GitHubRun> {
    const run = await this.json(connection, `/actions/runs/${externalId.parse(runId)}`, runSchema);
    let status: ExternalRun['status'] = 'unknown';

    if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') {
      status = 'queued';
    } else if (run.status === 'in_progress') {
      status = 'running';
    } else if (run.status === 'completed') {
      status = 'failed';

      if (run.conclusion === 'success') {
        status = 'succeeded';
      } else if (run.conclusion === 'cancelled') {
        status = 'cancelled';
      }
    }

    if (run.id !== runId) {
      throw new ProviderError(
        'PROVIDER_RESPONSE_INVALID',
        'GitHub returned a different workflow run.',
      );
    }

    return {
      id: run.id,
      pipelineId: run.workflow_id,
      commit: run.head_sha,
      status,
      originalStatus: `${run.status}/${run.conclusion ?? 'pending'}`,
      url: `https://github.com/${connection.repository}/actions/runs/${run.id}`,
      attempt: run.run_attempt,
      repositoryId: run.repository.id,
      headRepositoryId: run.head_repository?.id ?? null,
      branch: run.head_branch,
      event: run.event,
      startedAt: run.run_started_at,
    };
  }

  async listArtifacts(connection: ProviderConnection, runId: string) {
    const artifacts: (GitHubArtifact & { size: number; expiresAt: string | null })[] = [];

    for (let page = 1; page <= 10; page++) {
      const result = await this.json(
        connection,
        `/actions/runs/${externalId.parse(runId)}/artifacts?per_page=100&page=${page}`,
        z.object({
          artifacts: z.array(artifactSchema),
        }),
      );

      artifacts.push(
        ...result.artifacts.map((artifact) => ({
          ...artifact,
          size: artifact.size_in_bytes,
          expiresAt: artifact.expires_at,
        })),
      );

      if (result.artifacts.length < 100) {
        return artifacts;
      }
    }

    throw new ProviderError(
      'PROVIDER_PAGE_LIMIT',
      'This run exceeds the 1,000-artifact discovery limit.',
    );
  }

  async download(connection: ProviderConnection, artifactId: string): Promise<Buffer> {
    const response = await this.request(
      connection,
      `/actions/artifacts/${externalId.parse(artifactId)}/zip`,
    );

    const location = response.headers.get('location');

    await response.body?.cancel();

    if (response.status !== 302 || !location) {
      throw new ProviderError(
        'PROVIDER_RESPONSE_INVALID',
        'GitHub did not return an artifact download URL.',
      );
    }

    let url: URL;

    try {
      url = new URL(location);
    } catch {
      throw new ProviderError(
        'PROVIDER_REDIRECT_REJECTED',
        'GitHub returned an invalid download URL.',
      );
    }

    const allowedHost =
      url.hostname.endsWith('.blob.core.windows.net') ||
      url.hostname.endsWith('.actions.githubusercontent.com') ||
      url.hostname === 'objects.githubusercontent.com';

    if (
      !allowedHost ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    ) {
      throw new ProviderError(
        'PROVIDER_REDIRECT_REJECTED',
        'GitHub returned an unsupported artifact download host.',
      );
    }

    try {
      // Signed storage URLs are fetched without the GitHub credential and cannot redirect again.
      const archive = await this.transport(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });

      if (!archive.ok) {
        await archive.body?.cancel();
        throw new ProviderError(
          'PROVIDER_DOWNLOAD_FAILED',
          'The artifact download failed. The import will retry.',
          true,
        );
      }

      return await boundedResponse(archive, 25 * 1024 * 1024, 'GitHub');
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(
        'PROVIDER_DOWNLOAD_FAILED',
        'The artifact download was interrupted. The import will retry.',
        true,
      );
    }
  }
}
