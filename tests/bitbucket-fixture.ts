export function bitbucketFixture() {
  const repository = {
    uuid: '{11111111-1111-4111-8111-111111111111}',
    full_name: 'keel-test/application',
  };

  const state = {
    repository,
    run: {
      uuid: '{22222222-2222-4222-8222-222222222222}',
      build_number: 12,
      repository: { ...repository },
      state: { name: 'IN_PROGRESS', result: undefined as { name: string } | undefined },
      target: {
        type: 'pipeline_ref_target',
        ref_type: 'branch',
        ref_name: 'main',
        commit: { hash: 'b'.repeat(40) },
        selector: { type: 'branches', pattern: 'main' },
      },
    },
    step: {
      uuid: '{33333333-3333-4333-8333-333333333333}',
      state: { name: 'IN_PROGRESS', result: undefined as { name: string } | undefined },
    },
    apiStatus: 200,
    bytes: Buffer.from('Bitbucket build output retained independently of CI'),
    calls: [] as { url: string; init?: RequestInit }[],
    beforeResponse: undefined as ((url: string) => Promise<void>) | undefined,
  };

  const transport: typeof fetch = async (input, init) => {
    const url = input.toString();

    state.calls.push({ url, init });
    await state.beforeResponse?.(url);

    if (state.apiStatus !== 200) {
      return new Response('{}', { status: state.apiStatus, headers: { 'Retry-After': '45' } });
    }

    const path = new URL(url).pathname;
    let result: unknown;

    if (path.endsWith('/application')) {
      result = state.repository;
    } else if (path.endsWith('/pipelines/')) {
      result = { values: [] };
    } else if (path.includes('/steps/')) {
      result = state.step;
    } else {
      result = state.run;
    }

    return Response.json(result);
  };

  function succeed() {
    state.run.state = { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } };
    state.step.state = { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } };
  }

  return { state, transport, succeed };
}
