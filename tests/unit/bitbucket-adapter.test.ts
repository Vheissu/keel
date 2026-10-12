import { describe, expect, it } from 'vitest';
import {
  BitbucketPipelinesAdapter,
  bitbucketUuid,
} from '../../packages/integrations/src/bitbucket-pipelines.js';
import type { ProviderConnection } from '../../packages/integrations/src/index.js';
import { bitbucketFixture } from '../bitbucket-fixture.js';

const connection: ProviderConnection = {
  id: 'connection',
  organisationId: 'organisation',
  provider: 'bitbucket-pipelines',
  credentialReference: 'credential',
  repository: 'keel-test/application',
};

const credentials = { token: 'private-bitbucket-token', repository: connection.repository };

describe('Bitbucket provider transport', () => {
  it('uses fixed API URLs, bearer authentication and redirect rejection', async () => {
    const fixture = bitbucketFixture();
    const adapter = new BitbucketPipelinesAdapter(credentials, fixture.transport);

    await adapter.verifyConnection();
    const run = await adapter.getRun(connection, fixture.state.run.uuid);

    expect(run).toMatchObject({
      status: 'running',
      pipelineId: 'branches:main',
      repositoryId: fixture.state.repository.uuid,
    });

    for (const call of fixture.state.calls) {
      expect(new URL(call.url).origin).toBe('https://api.bitbucket.org');

      expect(new Headers(call.init?.headers).get('authorization')).toBe(
        `Bearer ${credentials.token}`,
      );

      expect(call.init?.redirect).toBe('error');
    }

    await expect(adapter.listArtifacts()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(adapter.listPipelines()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('normalises UUID spelling and rejects path traversal or malformed braces', () => {
    expect(bitbucketUuid.parse('AAAAAAAA-1111-4111-8111-111111111111')).toBe(
      '{aaaaaaaa-1111-4111-8111-111111111111}',
    );

    for (const value of [
      '../secrets',
      '{aaaaaaaa-1111-4111-8111-111111111111',
      'aaaaaaaa-1111-4111-8111-111111111111}',
      '{}',
      '123',
    ]) {
      expect(bitbucketUuid.safeParse(value).success).toBe(false);
    }
  });

  it.each([401, 403, 429, 500])(
    'sanitises provider error %s and reports retryability',
    async (status) => {
      const adapter = new BitbucketPipelinesAdapter(
        credentials,
        async () => new Response(credentials.token, { status, headers: { 'retry-after': '90' } }),
      );

      await expect(adapter.verifyConnection()).rejects.toMatchObject({
        retryable: status === 429 || status >= 500,
      });

      try {
        await adapter.verifyConnection();
      } catch (error) {
        expect(String(error)).not.toContain(credentials.token);
      }
    },
  );

  it('fails closed on malformed and oversized provider responses', async () => {
    const invalid = new BitbucketPipelinesAdapter(credentials, async () =>
      Response.json({ uuid: 'invalid' }),
    );

    const oversized = new BitbucketPipelinesAdapter(
      credentials,
      async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    );

    await expect(invalid.verifyConnection()).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_INVALID',
    });

    await expect(oversized.verifyConnection()).rejects.toMatchObject({
      code: 'PROVIDER_SIZE_LIMIT',
    });
  });

  it('rejects a different pipeline or step and never treats an unknown status as success', async () => {
    const fixture = bitbucketFixture();
    const adapter = new BitbucketPipelinesAdapter(credentials, fixture.transport);

    await expect(
      adapter.getRun(connection, '{aaaaaaaa-1111-4111-8111-111111111111}'),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });

    await expect(
      adapter.getStep(fixture.state.run.uuid, '{aaaaaaaa-1111-4111-8111-111111111111}'),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });

    fixture.state.run.state.name = 'FUTURE_STATUS';
    expect((await adapter.getRun(connection, fixture.state.run.uuid)).status).toBe('unknown');
  });
});
