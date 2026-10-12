import { z } from 'zod';
import {
  bitbucketCapabilities,
  type CIProviderAdapter,
  type ExternalArtifact,
  type ExternalPipeline,
  type ExternalRun,
  type ProviderConnection,
} from './index.js';
import { boundedResponse, ProviderError, rateLimitDelay } from './provider-http.js';

export const bitbucketRepository = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);

export const bitbucketUuid = z
  .string()
  .regex(/^\{?[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\}?$/)
  .refine((value) => value.startsWith('{') === value.endsWith('}'))
  .transform((value) => `{${value.replace(/[{}]/g, '').toLowerCase()}}`);

const repositorySchema = z.object({ uuid: bitbucketUuid, full_name: bitbucketRepository });

const stateSchema = z.object({
  name: z.string(),
  result: z.object({ name: z.string() }).optional(),
});

const runSchema = z.object({
  uuid: bitbucketUuid,
  build_number: z.number().int().positive(),
  repository: repositorySchema,
  state: stateSchema,
  target: z.object({
    type: z.string(),
    ref_type: z.string().optional(),
    ref_name: z.string().optional(),
    commit: z.object({ hash: z.string().regex(/^[a-f0-9]{40}$/) }),
    selector: z.object({ type: z.string(), pattern: z.string().optional() }).optional(),
  }),
});

export interface BitbucketCredentials {
  token: string;
  repository: string;
}

export interface BitbucketRun extends ExternalRun {
  repositoryId: string;
  branch: string | null;
  targetType: string;
  refType: string | null;
  buildNumber: number;
}

export class BitbucketPipelinesAdapter implements CIProviderAdapter {
  constructor(
    private credentials: BitbucketCredentials,
    private transport: typeof fetch = fetch,
  ) {}

  capabilities() {
    return { ...bitbucketCapabilities };
  }

  async listPipelines(): Promise<ExternalPipeline[]> {
    throw new ProviderError(
      'UNSUPPORTED_OPERATION',
      'Bitbucket workflow-definition discovery is unavailable. Configure a selector explicitly.',
    );
  }

  async listArtifacts(): Promise<ExternalArtifact[]> {
    throw new ProviderError(
      'UNSUPPORTED_OPERATION',
      'Bitbucket artifacts require the Keel publishing step.',
    );
  }

  private async json<T>(suffix: string, schema: z.ZodType<T>): Promise<T> {
    const repository = bitbucketRepository
      .parse(this.credentials.repository)
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    let response: Response;

    try {
      response = await this.transport(
        `https://api.bitbucket.org/2.0/repositories/${repository}${suffix}`,
        {
          headers: {
            Authorization: `Bearer ${this.credentials.token}`,
            Accept: 'application/json',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        },
      );
    } catch {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'Bitbucket could not be reached. The import will retry.',
        true,
      );
    }

    if (!response.ok) {
      await response.body?.cancel();

      if (response.status === 429) {
        throw new ProviderError(
          'PROVIDER_RATE_LIMIT',
          'Bitbucket rate limited this connection. The import will retry.',
          true,
          rateLimitDelay(response.headers),
        );
      }

      if ([401, 403].includes(response.status)) {
        throw new ProviderError(
          'PROVIDER_AUTH_FAILED',
          'Bitbucket denied access. Check or rotate the repository access token.',
        );
      }

      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'Bitbucket could not return the repository or pipeline.',
        response.status >= 500,
      );
    }

    try {
      const bytes = await boundedResponse(response, 2 * 1024 * 1024, 'Bitbucket');

      return schema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(
        'PROVIDER_RESPONSE_INVALID',
        'Bitbucket returned unexpected metadata.',
      );
    }
  }

  async verifyConnection() {
    const repository = await this.json('', repositorySchema);

    // Verify Pipelines read permission without claiming workflow-definition discovery.
    await this.json('/pipelines/?pagelen=1', z.object({ values: z.array(z.unknown()) }));

    return repository;
  }

  async getRun(connection: ProviderConnection, id: string): Promise<BitbucketRun> {
    const runId = bitbucketUuid.parse(id);
    const run = await this.json(`/pipelines/${encodeURIComponent(runId)}`, runSchema);

    if (run.uuid !== runId) {
      throw new ProviderError(
        'PROVIDER_RESPONSE_INVALID',
        'Bitbucket returned a different pipeline.',
      );
    }

    let status: ExternalRun['status'] = 'unknown';

    if (run.state.name === 'PENDING') {
      status = 'queued';
    } else if (run.state.name === 'IN_PROGRESS') {
      status = 'running';
    } else if (run.state.name === 'COMPLETED') {
      status = run.state.result?.name === 'SUCCESSFUL' ? 'succeeded' : 'failed';

      if (run.state.result?.name === 'STOPPED') {
        status = 'cancelled';
      }
    }

    return {
      id: run.uuid,
      pipelineId: `${run.target.selector?.type ?? 'unknown'}:${run.target.selector?.pattern ?? ''}`,
      commit: run.target.commit.hash,
      status,
      originalStatus: `${run.state.name}/${run.state.result?.name ?? 'pending'}`,
      url: `https://bitbucket.org/${connection.repository}/pipelines/results/${run.build_number}`,
      repositoryId: run.repository.uuid,
      branch: run.target.ref_name ?? null,
      targetType: run.target.type,
      refType: run.target.ref_type ?? null,
      buildNumber: run.build_number,
    };
  }

  async getStep(runId: string, id: string) {
    const stepId = bitbucketUuid.parse(id);

    const step = await this.json(
      `/pipelines/${encodeURIComponent(bitbucketUuid.parse(runId))}/steps/${encodeURIComponent(stepId)}`,
      z.object({ uuid: bitbucketUuid, state: stateSchema }),
    );

    if (step.uuid !== stepId) {
      throw new ProviderError(
        'PROVIDER_RESPONSE_INVALID',
        'Bitbucket returned a different pipeline step.',
      );
    }

    return step;
  }
}
