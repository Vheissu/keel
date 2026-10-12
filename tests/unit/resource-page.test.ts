import { afterEach, expect, it, vi } from 'vitest';
import { ResourcePage } from '../../apps/web/src/resource-page.js';
import type { Api } from '../../apps/web/src/api.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

const result = (name: string) => ({
  items: [name],
  total: 1,
  limit: 25,
  previous_cursor: null,
  next_cursor: null,
});

afterEach(() => vi.unstubAllGlobals());

it('keeps the newest search result when an earlier request finishes late', async () => {
  const first = deferred<ReturnType<typeof result>>();
  const second = deferred<ReturnType<typeof result>>();
  const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const pager = new ResourcePage<string>({ request } as unknown as Api, 'projects');
  const loadingFirst = pager.load();

  pager.query = 'new search';
  const loadingSecond = pager.load();

  second.resolve(result('new search result'));
  await loadingSecond;
  first.resolve(result('stale result'));
  await loadingFirst;
  expect(pager.items).toEqual(['new search result']);
  expect(pager.loading).toBe(false);
});

it('ignores a response after leaving a resource or disconnecting', async () => {
  vi.stubGlobal('window', { removeEventListener: vi.fn() });
  const response = deferred<ReturnType<typeof result>>();

  const pager = new ResourcePage<string>(
    { request: () => response.promise } as unknown as Api,
    'projects',
  );

  const loading = pager.load();

  pager.dispose();
  response.resolve(result('previous workspace record'));
  await loading;
  expect(pager.items).toEqual([]);
});

it('clears stale data and allows recovery after a page request fails', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(result('original'))
    .mockRejectedValueOnce(new Error('Page unavailable'))
    .mockResolvedValueOnce(result('recovered'));

  const pager = new ResourcePage<string>({ request } as unknown as Api, 'projects');

  await pager.load();
  await pager.load();
  expect(pager.items).toEqual([]);
  expect(pager.error).toBe('Page unavailable');
  expect(pager.nextCursor).toBeNull();
  await pager.load();
  expect(pager.items).toEqual(['recovered']);
  expect(pager.error).toBe('');
});

it('does not reset a page when a delayed search was already applied by a page-size change', async () => {
  const request = vi.fn().mockResolvedValue(result('matched'));
  const pager = new ResourcePage<string>({ request } as unknown as Api, 'projects');

  pager.query = 'matched';
  pager.limit = 50;
  await pager.navigate();
  await pager.navigate('next-page');
  await pager.search();
  expect(pager.cursor).toBe('next-page');
  expect(request).toHaveBeenCalledTimes(2);
});

it('falls back to the default page size for an edited page link', async () => {
  vi.stubGlobal('window', {
    location: { hash: '#projects?projects.limit=1000&other.limit=50' },
    addEventListener: vi.fn(),
  });

  const request = vi.fn().mockResolvedValue(result('first'));
  const pager = new ResourcePage<string>({ request } as unknown as Api, 'projects', 'projects');

  await pager.start();
  expect(pager.limit).toBe(25);
  expect(request).toHaveBeenCalledWith('/resources/projects?limit=25&q=');
});
