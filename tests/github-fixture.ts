import { sha256 } from '../apps/api/src/artifact-store.js';

export function githubFixture() {
  const bytes = Buffer.from('PK\x03\x04retained GitHub artifact archive');
  const repository = { id: 123, full_name: 'keel-test/application' };

  const run = {
    id: 9001,
    workflow_id: 42,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    head_branch: 'main',
    event: 'push',
    run_started_at: '2026-01-01T00:00:00Z',
    repository,
    head_repository: { ...repository },
  };

  const artifact = {
    id: 8001,
    name: 'application',
    size_in_bytes: bytes.length,
    expired: false,
    expires_at: '2099-01-01T00:00:00Z',
    created_at: '2026-01-01T00:01:00Z',
    digest: `sha256:${sha256(bytes)}`,
    workflow_run: {
      id: run.id,
      head_sha: run.head_sha,
      repository_id: repository.id,
      head_repository_id: repository.id,
    },
  };

  const state = {
    repository,
    run,
    artifacts: [artifact],
    bytes,
    redirect: 'https://test.blob.core.windows.net/artifacts/archive?signature=temporary',
    apiStatus: 200,
    retryAfter: '1',
    beforeDownload: undefined as (() => Promise<void>) | undefined,
    calls: [] as { url: string; init?: RequestInit }[],
  };

  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));

    state.calls.push({ url: url.toString(), init });

    if (url.hostname === 'test.blob.core.windows.net') {
      await state.beforeDownload?.();

      return new Response(new Uint8Array(state.bytes), { status: 200 });
    }

    if (state.apiStatus !== 200) {
      return new Response('Provider details must never be persisted', {
        status: state.apiStatus,
        headers: { 'retry-after': state.retryAfter },
      });
    }

    const path = url.pathname;

    if (path.endsWith('/actions/artifacts/8001/zip')) {
      return new Response(null, { status: 302, headers: { location: state.redirect } });
    }

    if (path.endsWith('/actions/runs/9001/artifacts')) {
      return Response.json({ total_count: state.artifacts.length, artifacts: state.artifacts });
    }

    if (path.endsWith('/actions/runs/9001')) {
      return Response.json(state.run);
    }

    if (path.endsWith('/actions/workflows/42')) {
      return Response.json({ id: 42, name: 'Build application' });
    }

    if (path.endsWith('/actions/workflows')) {
      return Response.json({ workflows: [{ id: 42, name: 'Build application' }] });
    }

    if (path === '/repos/keel-test/application') {
      return Response.json(state.repository);
    }

    return new Response(null, { status: 404 });
  };

  return { state, transport };
}
