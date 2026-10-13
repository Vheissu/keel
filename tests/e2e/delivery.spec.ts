import { NotificationWorker } from '../../apps/api/src/notification-worker.js';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { fixture, deploymentProcess, testDatabaseUrl } from '../fixtures.js';
import { migrate } from '../../packages/database/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import { ExecutionService } from '../../apps/api/src/execution-service.js';
import { ControlPlane } from '../../apps/api/src/control-plane.js';
import { LocalArtifactStore } from '../../apps/api/src/artifact-store.js';
import { CredentialVault } from '../../apps/api/src/credential-vault.js';
import { IntegrationService } from '../../apps/api/src/integration-service.js';
import { ArtifactImportWorker } from '../../apps/api/src/artifact-import-worker.js';
import { GitHubActionsAdapter } from '../../packages/integrations/src/github-actions.js';
import { BitbucketPipelinesAdapter } from '../../packages/integrations/src/bitbucket-pipelines.js';
import { bitbucketFixture } from '../bitbucket-fixture.js';
import { sha256 } from '../../apps/api/src/artifact-store.js';
import { githubFixture } from '../github-fixture.js';

const schema = `e2e_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let app: FastifyInstance, root: string, f: Awaited<ReturnType<typeof fixture>>;
let errors: string[] = [];
let github = githubFixture();
let bitbucket = bitbucketFixture();
let importWorker: ArtifactImportWorker;
let integrations: IntegrationService;
let control: ControlPlane;

test.beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-e2e-'));

  control = new ControlPlane(
    db,
    new LocalArtifactStore(root),
    new CredentialVault(randomBytes(32).toString('base64'), 'deployment-secrets'),
  );

  integrations = new IntegrationService(
    control,
    new CredentialVault(randomBytes(32).toString('base64')),
    (credentials) =>
      new GitHubActionsAdapter(
        async () => credentials,
        (...args) => github.transport(...args),
      ),
    (credentials) =>
      new BitbucketPipelinesAdapter(credentials, (...args) => bitbucket.transport(...args)),
  );

  importWorker = new ArtifactImportWorker(integrations);
  await mkdir('output/playwright', { recursive: true });
});

test.beforeEach(async ({ page }) => {
  f = await fixture(db);
  errors = [];
  github = githubFixture();
  bitbucket = bitbucketFixture();
  app = await createApp(control, false, integrations);
  await app.listen({ host: '127.0.0.1', port: 4051 });
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(async () => {
  await app.close();
  expect(errors).toEqual([]);
});

test.afterAll(async () => {
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

async function connect(page: Page, token = f.operator.token) {
  await page.goto('/');
  await page.getByLabel('API token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
}

test('publishes an artifact, creates a release, and obtains a separate production approval', async ({
  page,
  browser,
}) => {
  await connect(page);
  await page.screenshot({ path: 'output/playwright/overview-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Customer portal');
  await expect(page.getByLabel('Project slug', { exact: true })).toHaveValue('customer-portal');
  await page.getByLabel('Description (optional)').fill('Customer-facing web application');

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();

  await expect(page.getByRole('cell', { name: 'Customer portal customer-portal' })).toBeVisible();
  await page.getByRole('link', { name: 'Artifacts', exact: true }).click();
  await page.getByRole('button', { name: 'Publish artifact', exact: true }).click();
  await page.getByLabel('Artifact name', { exact: true }).fill('application');
  await page.getByLabel('Artifact version', { exact: true }).fill('1.0.0');

  await page.getByLabel('Artifact file', { exact: true }).setInputFiles({
    name: 'application.tar.gz',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('immutable external CI build'),
  });

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Publish artifact', exact: true })
    .click();

  await expect(page.getByRole('dialog')).not.toBeVisible();

  await expect(
    page.getByRole('status').filter({ hasText: 'Artifact verified and retained.' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Releases', exact: true }).click();
  await page.getByRole('button', { name: 'Create release', exact: true }).click();
  await page.getByLabel('Release version', { exact: true }).fill('1.0.0');

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create release', exact: true })
    .click();

  await expect(page.getByRole('button', { name: '1.0.0', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '1.0.0', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('"source": "direct-upload"');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: /^Deploy / }).click();

  await page
    .getByLabel('Environment', { exact: true })
    .selectOption({ label: 'Production · approval required' });

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Request deployment', exact: true })
    .click();

  await expect(page.getByText('Awaiting approval', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Approve / })).toHaveCount(0);
  const context = await browser.newContext();
  const approver = await context.newPage();

  await connect(approver, f.approver.token);
  await approver.getByRole('link', { name: /Deployments/ }).click();
  await approver.getByRole('button', { name: /^Approve / }).click();
  await expect(approver.getByText('Waiting for agent', { exact: true })).toBeVisible();
  await expect(approver.getByRole('button', { name: 'Request deployment' })).toHaveCount(0);
  await context.close();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Waiting for agent', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'output/playwright/deployment-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'deployment.queued', exact: true })).toBeVisible();
});

test('supports keyboard dialogs, hash navigation, search, and readable mobile layout', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Search projects').fill('missing');
  await expect(page.getByRole('heading', { name: 'No matching projects.' })).toBeVisible();
  await page.getByRole('link', { name: 'Environments', exact: true }).click();
  await expect(page).toHaveURL(/#environments$/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.screenshot({ path: 'output/playwright/overview-mobile.png', fullPage: true });
  await page.getByRole('button', { name: /Disconnect/ }).click();
  await expect(page.getByLabel('API token', { exact: true })).toBeVisible();
});

test('has accessible overview and forms and respects reduced-motion loading', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await connect(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  let releaseRequest!: () => void;

  const hold = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });

  await page.route('**/api/v1/snapshot', async (route) => {
    await hold;
    await route.continue();
  });

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Loading workspace…')).toBeVisible();

  expect(
    await page
      .locator('.loading-inline .boat-hull')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');

  releaseRequest();
  await expect(page.getByText('Loading workspace…')).toHaveCount(0);
});

test('connects GitHub, retries a failed import, and uses the retained artifact in a release', async ({
  page,
}) => {
  await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { authorization: `Bearer ${f.operator.token}`, 'idempotency-key': randomUUID() },
    payload: { name: 'Imported application', slug: 'imported-application' },
  });

  await connect(page);
  await page.getByRole('link', { name: 'Integrations', exact: true }).click();
  await page.getByRole('button', { name: 'Connect GitHub Actions', exact: true }).click();
  await expect(page.getByLabel('Connection name', { exact: true })).toBeFocused();
  await page.getByLabel('Connection name', { exact: true }).fill('Application builds');
  await page.getByLabel('GitHub repository', { exact: true }).fill('keel-test/application');
  await page.getByLabel('Workflow ID', { exact: true }).fill('42');
  await page.getByLabel('GitHub access token', { exact: true }).fill('github-browser-test-token');

  await page
    .getByLabel('Webhook secret', { exact: true })
    .fill('browser-webhook-test-secret-over-32-characters');

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Application builds' })).toBeVisible();
  await page.getByRole('button', { name: /^Import run / }).click();
  await page.getByLabel('Workflow run ID', { exact: true }).fill('9001');
  await page.getByRole('button', { name: 'Queue import', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Queued', exact: true })).toBeVisible();

  const retainedBytes = github.state.bytes;

  github.state.bytes = Buffer.from('tampered-download');
  await importWorker.runOnce();
  await page.getByRole('button', { name: 'Refresh imports', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Failed', exact: true })).toBeVisible();
  github.state.bytes = retainedBytes;
  await page.getByRole('button', { name: /^Retry import / }).click();
  await expect(page.getByRole('cell', { name: 'Queued', exact: true })).toBeVisible();
  await importWorker.runOnce();
  await page.getByRole('button', { name: 'Refresh imports', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Retained', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/integrations-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Application builds' })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.screenshot({ path: 'output/playwright/integrations-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'View artifacts', exact: true }).click();

  await expect(
    page.getByRole('cell', { name: 'application gh-9001.1.8001', exact: true }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Releases', exact: true }).click();
  let releaseArtifacts!: () => void;

  const artifactOptions = new Promise<void>((resolve) => {
    releaseArtifacts = resolve;
  });

  await page.route(/\/api\/v1\/resources\/artifacts(?:\?|$)/, async (route) => {
    await artifactOptions;
    await route.continue();
  });

  await page.getByRole('button', { name: 'Create release', exact: true }).click();
  await page.getByLabel('Release version', { exact: true }).fill('2.0.0');

  try {
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Create release', exact: true }),
    ).toBeDisabled();
  } finally {
    releaseArtifacts();
  }

  await expect(page.getByLabel('Artifact', { exact: true })).not.toHaveValue('');

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create release', exact: true })
    .click();

  await page.getByRole('button', { name: '2.0.0', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('"source": "github-actions"');
});

test('connects Bitbucket, waits for successful CI, and manages publishing credentials accessibly', async ({
  page,
}) => {
  const project = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { authorization: `Bearer ${f.operator.token}`, 'idempotency-key': randomUUID() },
    payload: { name: 'Bitbucket application', slug: 'bitbucket-app' },
  });

  expect(project.statusCode).toBe(200);
  await connect(page);
  await page.getByRole('link', { name: 'Integrations', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Bitbucket Pipelines', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Bitbucket release builds');
  await page.getByLabel('Bitbucket repository', { exact: true }).fill('keel-test/application');
  await expect(page.getByLabel('Pipeline selector', { exact: true })).toHaveValue('branches:main');

  await page
    .getByLabel('Bitbucket repository access token', { exact: true })
    .fill('bitbucket-browser-test-repository-token');

  await page
    .getByLabel('Publishing secret', { exact: true })
    .fill('bitbucket-browser-publishing-secret-32');

  expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bitbucket release builds' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import run / })).toHaveCount(0);
  await page.getByText('Publishing setup', { exact: true }).click();
  await expect(page.getByText(/KEEL_CONNECTION_ID=/)).toBeVisible();

  const connection = (
    await app.inject({
      method: 'GET',
      url: '/api/v1/integrations',
      headers: { authorization: `Bearer ${f.operator.token}` },
    })
  ).json().connections[0];

  const submission = await app.inject({
    method: 'POST',
    url: `/publish/bitbucket/${connection.id}`,
    headers: {
      authorization: 'Bearer bitbucket-browser-publishing-secret-32',
      'content-type': 'application/octet-stream',
      'x-bitbucket-pipeline': bitbucket.state.run.uuid,
      'x-bitbucket-step': bitbucket.state.step.uuid,
      'x-bitbucket-commit': bitbucket.state.run.target.commit.hash,
      'x-artifact-sha256': sha256(bitbucket.state.bytes),
    },
    payload: bitbucket.state.bytes,
  });

  expect(submission.statusCode).toBe(202);
  await importWorker.runOnce();
  await page.getByRole('button', { name: 'Refresh imports' }).click();

  await expect(
    page.getByText('Waiting for the full Bitbucket pipeline to succeed.', { exact: true }),
  ).toBeVisible();

  bitbucket.succeed();

  await db.query('UPDATE artifact_imports SET available_at = now() WHERE id = $1', [
    submission.json().id,
  ]);

  await importWorker.runOnce();
  await page.getByRole('button', { name: 'Refresh imports' }).click();
  await expect(page.getByText('Retained', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Rotate credentials / }).click();
  await expect(page.getByLabel('Publishing secret', { exact: true })).toHaveValue('');

  await page
    .getByLabel('Bitbucket repository access token', { exact: true })
    .fill('bitbucket-browser-test-rotated-token');

  await page
    .getByLabel('Publishing secret', { exact: true })
    .fill('bitbucket-browser-publishing-secret-rotated');

  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: /^Disable / }).click();
  await expect(page.getByRole('button', { name: /^Enable / })).toBeVisible();
  await page.getByRole('button', { name: /^Enable / }).click();
  await expect(page.getByRole('button', { name: /^Disable / })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/bitbucket-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.screenshot({ path: 'output/playwright/bitbucket-mobile.png', fullPage: true });
});

test('registers and drains private agents, maps local and SSH targets and remains accessible on mobile', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Docker service');

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();

  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Targets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No agents registered.' })).toBeVisible();
  await page.getByRole('button', { name: 'Register agent', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Private staging host');
  await page.getByLabel('Certificate SHA-256 fingerprint').fill(randomBytes(32).toString('hex'));
  await page.getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByRole('cell').filter({ hasText: 'Private staging host' })).toBeVisible();
  await page.getByRole('button', { name: 'Add target', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Web staging');
  await expect(page.getByLabel('Connection', { exact: true })).toHaveValue('docker-recreate-v1');
  await page.getByLabel('Connection', { exact: true }).selectOption('docker-blue-green-v1');
  await expect(page.getByLabel('Connection', { exact: true })).toHaveValue('docker-blue-green-v1');
  await page.getByLabel('Connection', { exact: true }).selectOption('ssh-docker-recreate-v1');
  await page.getByLabel('Environment', { exact: true }).selectOption({ label: 'Staging' });
  await page.getByRole('button', { name: 'Save registration' }).click();

  await expect(page.getByRole('cell').filter({ hasText: 'Web staging' })).toContainText(
    'Docker over SSH',
  );

  await page.reload();
  await page.getByLabel('API token', { exact: true }).fill(f.operator.token);
  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click();

  await expect(page.getByRole('cell').filter({ hasText: 'Web staging' })).toContainText(
    'Docker over SSH',
  );

  await expect(page.getByRole('cell', { name: 'Unknown', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Drain / }).click();
  await expect(page.getByRole('cell', { name: 'draining', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Replace certificate / }).click();
  await expect(page.getByRole('heading', { name: 'Replace agent certificate' })).toBeVisible();
  await page.getByLabel('Certificate SHA-256 fingerprint').fill(randomBytes(32).toString('hex'));
  await page.getByLabel('I stopped the old agent').check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page
    .locator('form')
    .getByRole('button', { name: 'Replace certificate', exact: true })
    .click();

  await expect(page.getByRole('status').filter({ hasText: 'Certificate replaced.' })).toBeVisible();
  await page.getByRole('button', { name: /^Resume / }).click();
  await expect(page.getByRole('cell', { name: 'active', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/targets-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /^Drain / }).click();
  await page.getByRole('button', { name: /^Replace certificate / }).click();
  await expect(page.getByLabel('Certificate SHA-256 fingerprint')).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/targets-mobile.png', fullPage: true });
});

test('enforces promotion policy and reviews a retained-release rollback with a separate approver', async ({
  page,
  browser,
}) => {
  const post = async (path: string, body: unknown, token = f.operator.token) => {
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
        'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      },
      payload: body as never,
    });

    expect(result.statusCode, result.body).toBe(200);

    return result.json();
  };

  const project = await post('/projects', { name: 'Rollback service', slug: 'rollback-service' });
  const releases: { id: string }[] = [];
  const definition = deploymentProcess();

  Object.assign(definition.spec.artifact, { dockerImageId: `sha256:${'a'.repeat(64)}` });

  for (const environment of Object.values(definition.spec.environments)) {
    Object.assign(environment, { strategy: 'recreate', verify: { http: { path: '/' } } });
  }

  for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
    const bytes = Buffer.from(`retained Docker image ${version}`);

    const artifact = await post(
      `/artifacts?${new URLSearchParams({ project_id: project.id, name: 'application', version, digest: sha256(bytes) })}`,
      bytes,
    );

    releases.push(
      await post('/releases', {
        project_id: project.id,
        artifact_id: artifact.id,
        version,
        process: definition,
      }),
    );
  }

  const fingerprint = randomBytes(32).toString('hex');

  const registered = await post('/agents', {
    name: 'Private delivery host',
    certificate_fingerprint: fingerprint,
  });

  for (const [slug, environment] of Object.entries(f.environments)) {
    await post('/targets', {
      name: `${slug} web`,
      project_id: project.id,
      environment_id: environment,
      agent_id: registered.id,
      labels: { tier: slug },
    });
  }

  const context = await browser.newContext();
  const approver = await context.newPage();

  await connect(approver, f.approver.token);
  await approver.getByRole('link', { name: 'Environments', exact: true }).click();
  await approver.getByRole('button', { name: 'Edit Production promotion policy' }).click();

  await approver
    .getByLabel('Required prior environment', { exact: true })
    .selectOption({ label: 'Staging' });

  await approver.getByRole('button', { name: 'Save promotion policy' }).click();

  await expect(
    approver.getByRole('status').filter({ hasText: 'Promotion policy saved' }),
  ).toBeVisible();

  await expect(approver.getByText('Loading workspace…', { exact: true })).not.toBeVisible();

  await expect(
    approver.getByRole('button', { name: 'Edit Production promotion policy' }),
  ).toBeFocused();

  expect((await new AxeBuilder({ page: approver }).analyze()).violations).toEqual([]);
  const execution = new ExecutionService(control);
  const identity = await execution.authenticate(fingerprint);

  for (const release of releases.slice(0, 2)) {
    for (const environment of [f.environments.staging, f.environments.production]) {
      const deployment = await post('/deployments', {
        release_id: release.id,
        environment_id: environment,
      });

      if (deployment.status === 'awaiting_approval') {
        await post(`/deployments/${deployment.id}/approve`, {}, f.approver.token);
      }

      await execution.tick(f.org, deployment.id);
      const job = (await execution.claim(identity))!;

      await execution.complete(identity, {
        attempt_id: job.attempt_id,
        fence: job.fence,
        token: job.token,
        outcome: 'succeeded',
        code: 'HTTP_VERIFIED',
      });
    }
  }

  await connect(page);
  await page.getByRole('link', { name: 'Environments', exact: true }).click();
  await expect(page.getByRole('button', { name: /Edit .* promotion policy/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Releases', exact: true }).click();

  await page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: '3.0.0', exact: true }) })
    .getByRole('button', { name: /^Deploy / })
    .click();

  await page
    .getByLabel('Environment', { exact: true })
    .selectOption({ label: 'Production · approval required' });

  await expect(page.getByRole('dialog')).toContainText(
    'This exact release needs a verified deployment',
  );

  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Request deployment', exact: true }),
  ).toBeDisabled();

  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('link', { name: 'Deployments', exact: true }).click();

  const current = page
    .getByRole('row')
    .filter({ hasText: '2.0.0' })
    .filter({ hasText: 'Production' });

  await current.getByRole('button', { name: /^Plan rollback / }).click();
  await expect(page.getByRole('heading', { name: 'Plan an application rollback' })).toBeFocused();
  await page.getByRole('button', { name: 'Close rollback planner' }).click();
  await expect(current.getByRole('button', { name: /^Plan rollback / })).toBeFocused();
  await current.getByRole('button', { name: /^Plan rollback / }).click();
  await page.getByRole('button', { name: 'Review rollback plan' }).click();
  await expect(page.getByRole('heading', { name: 'Release 1.0.0 → Production' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request rollback', exact: true })).toBeDisabled();
  await expect(page.getByText('A different person must approve', { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/rollback-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/rollback-mobile.png', fullPage: true });
  await page.getByLabel('I checked compatibility').check();
  await page.getByRole('button', { name: 'Request rollback', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: 'Plan an application rollback' }),
  ).not.toBeVisible();

  await expect(page.getByRole('row').filter({ hasText: 'Application rollback' })).toContainText(
    'Awaiting approval',
  );

  await approver.getByRole('button', { name: 'Refresh', exact: true }).click();
  await approver.getByRole('link', { name: 'Deployments', exact: true }).click();

  await approver
    .getByRole('row')
    .filter({ hasText: 'Application rollback' })
    .getByRole('button', { name: /^Approve / })
    .click();

  await expect(approver.getByRole('row').filter({ hasText: 'Application rollback' })).toContainText(
    'Waiting for agent',
  );

  await context.close();
});

test('manages scoped secrets and reviews pinned versions without disclosing values', async ({
  page,
  browser,
}) => {
  // Two browser identities, history navigation and accessibility scans share this budget.
  test.setTimeout(60000);
  const manager = randomUUID();
  const managerToken = randomBytes(32).toString('hex');

  await db.query('INSERT INTO actors(id,organisation_id,name) VALUES($1,$2,$3)', [
    manager,
    f.org,
    'Secret manager',
  ]);

  await db.query(
    `
      INSERT INTO
        api_tokens (
          id,
          organisation_id,
          actor_id,
          token_hash,
          permissions
        )
      VALUES
        ($1, $2, $3, $4, $5)
    `,
    [randomUUID(), f.org, manager, sha256(managerToken), ['read', 'manage_secrets']],
  );

  const post = async (path: string, payload: unknown) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${f.operator.token}`,
        'idempotency-key': randomUUID(),
        'content-type': Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json',
      },
      payload: payload as never,
    });

    expect(response.statusCode, response.body).toBe(200);

    return response.json();
  };

  const project = await post('/projects', { name: 'Secret application', slug: 'secret-app' });
  const bytes = Buffer.from('secret application image');

  const artifact = await post(
    `/artifacts?${new URLSearchParams({ project_id: project.id, name: 'application', version: '1', digest: sha256(bytes) })}`,
    bytes,
  );

  const process = deploymentProcess();

  for (const environment of Object.values(process.spec.environments)) {
    Object.assign(environment, { secrets: { APP_PASSWORD: { secret: 'DATABASE_PASSWORD' } } });
  }

  await post('/releases', {
    project_id: project.id,
    artifact_id: artifact.id,
    version: '1.0.0',
    process,
  });

  await connect(page, managerToken);
  await page.getByRole('link', { name: 'Secrets', exact: true }).click();
  await page.getByLabel('Secret environment', { exact: true }).selectOption({ label: 'Staging' });
  await page.getByRole('button', { name: 'Add secret', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add a deployment secret' })).toBeFocused();
  await page.getByLabel('Secret name', { exact: true }).fill('DATABASE_PASSWORD');
  const secretValue = `browser-private-${randomUUID()}`;

  await page.getByLabel('Secret value', { exact: true }).fill(secretValue);

  await expect(page.getByLabel('Secret value', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/secrets') && response.request().method() === 'POST',
  );

  await page.getByRole('button', { name: 'Save secret', exact: true }).click();
  expect(await (await saveResponse).text()).not.toContain(secretValue);

  await expect(
    page.getByRole('status').filter({ hasText: 'DATABASE_PASSWORD saved' }),
  ).toBeVisible();

  await expect(page.getByRole('row').filter({ hasText: 'DATABASE_PASSWORD' })).toContainText(
    'Available',
  );

  await expect(page.getByRole('button', { name: 'Add secret', exact: true })).toBeFocused();

  await page
    .getByLabel('Secret environment', { exact: true })
    .selectOption(f.environments.production);

  await expect(page.getByRole('row').filter({ hasText: 'DATABASE_PASSWORD' })).toHaveCount(0);
  await page.goBack();

  await expect(page.getByLabel('Secret environment', { exact: true })).toHaveValue(
    f.environments.staging,
  );

  await expect(page.getByRole('row').filter({ hasText: 'DATABASE_PASSWORD' })).toContainText(
    'Available',
  );

  expect(await page.content()).not.toContain(secretValue);

  const context = await browser.newContext();
  const operator = await context.newPage();

  operator.on('pageerror', (error) => errors.push(error.message));
  await connect(operator);
  await operator.getByRole('link', { name: 'Secrets', exact: true }).click();
  await expect(operator.getByRole('button', { name: 'Add secret', exact: true })).toHaveCount(0);
  await operator.getByRole('link', { name: 'Releases', exact: true }).click();

  await operator
    .getByRole('button', { name: 'Deploy 1.0.0 of Secret application', exact: true })
    .click();

  await operator
    .getByLabel('Environment', { exact: true })
    .selectOption({ label: 'Production · approval required' });

  await expect(operator.getByRole('dialog')).toContainText(
    'A referenced secret is missing or revoked',
  );

  await expect(
    operator.getByRole('button', { name: 'Request deployment', exact: true }).last(),
  ).toBeDisabled();

  await operator.getByLabel('Environment', { exact: true }).selectOption({ label: 'Staging' });
  await expect(operator.getByRole('dialog')).toContainText('DATABASE_PASSWORD · version 1');

  await operator
    .getByRole('dialog')
    .getByRole('button', { name: 'Request deployment', exact: true })
    .click();

  await expect(operator.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Rotate DATABASE_PASSWORD', exact: true }).click();
  await page.getByLabel('Secret value', { exact: true }).fill('browser-rotated-value');
  await page.getByRole('button', { name: 'Save secret', exact: true }).click();

  await expect(page.getByRole('row').filter({ hasText: 'DATABASE_PASSWORD' })).toContainText(
    'Revision 2',
  );

  await operator.getByRole('button', { name: 'Secret versions', exact: true }).click();
  await expect(operator.getByRole('dialog')).toContainText('DATABASE_PASSWORD · version 1');
  expect((await new AxeBuilder({ page: operator }).analyze()).violations).toEqual([]);
  await operator.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'Revoke DATABASE_PASSWORD', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revoke all versions' })).toBeDisabled();
  await page.getByLabel('Revoke every version and block pending deployments').check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/secrets-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/secrets-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Revoke all versions' }).click();

  await expect(page.getByRole('row').filter({ hasText: 'DATABASE_PASSWORD' })).toContainText(
    'Revoked',
  );

  await operator.getByRole('button', { name: 'Secret versions', exact: true }).click();
  await expect(operator.getByRole('dialog')).toContainText('version 1 · revoked');

  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain(secretValue);

  await context.close();
});

test('navigates and searches beyond 200 records and retains paged selector choices', async ({
  page,
}) => {
  await db.query(
    `
      INSERT INTO
        projects (id, organisation_id, name, slug, created_at)
      SELECT
        gen_random_uuid(),
        $1,
        'Project ' || lpad(n::text, 3, '0'),
        'project-' || n,
        '2026-01-01'::timestamptz + n * interval '1 second'
      FROM
        generate_series(1, 237) n
    `,
    [f.org],
  );

  await connect(page);
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(25);
  const first = await page.locator('tbody tr').first().innerText();

  await page.getByRole('button', { name: 'Next projects', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(25);
  await expect(page.locator('tbody tr').first()).not.toHaveText(first);
  await expect(page).toHaveURL(/projects.cursor=/);
  await page.goBack();
  await expect(page.locator('tbody tr').first()).toHaveText(first);
  await page.getByLabel('Search projects', { exact: true }).fill('Project 001');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('Project 001');
  await page.getByLabel('Search projects', { exact: true }).fill('');
  await page.getByLabel('Projects per page', { exact: true }).selectOption('50');
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: 'Next projects', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toContainText('Project 187');
  const retainedUrl = page.url();
  const retainedRow = await page.locator('tbody tr').first().innerText();

  await page.reload();
  await page.getByLabel('API token', { exact: true }).fill(f.operator.token);
  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click();
  await expect(page).toHaveURL(retainedUrl);
  await expect(page.locator('tbody tr').first()).toHaveText(retainedRow);
  await page.getByRole('link', { name: 'Artifacts', exact: true }).click();
  await page.getByRole('button', { name: 'Publish artifact', exact: true }).click();
  await page.getByLabel('Search project options', { exact: true }).fill('Project 001');
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Project 001' });
  const selected = await page.getByLabel('Project', { exact: true }).inputValue();

  await page.getByLabel('Search project options', { exact: true }).fill('Project 23');

  await expect(
    page.getByRole('status').filter({ hasText: '8 of 8 matching project options' }),
  ).toBeVisible();

  await expect(page.getByLabel('Project', { exact: true })).toHaveValue(selected);
  await page.getByLabel('Artifact name', { exact: true }).fill('old-project-build');
  await page.getByLabel('Artifact version', { exact: true }).fill('1.0.0');

  await page.getByLabel('Artifact file', { exact: true }).setInputFiles({
    name: 'build',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('old project build'),
  });

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Publish artifact', exact: true })
    .click();

  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('tbody')).toContainText('Project 001');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Search artifacts', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('creates a release from an older artifact and selects a release beyond the snapshot window', async ({
  page,
}) => {
  const project = randomUUID();
  const bytes = Buffer.from('retained older artifact');
  const digest = sha256(bytes);

  await control.store.put(f.org, digest, bytes);

  await db.query(
    "INSERT INTO projects(id,organisation_id,name,slug) VALUES($1,$2,'Archive','archive')",
    [project, f.org],
  );

  await db.query(
    `
    INSERT INTO
      artifacts (
        id,
        organisation_id,
        project_id,
        name,
        version,
        digest,
        size,
        provenance,
        created_at
      )
    SELECT
      gen_random_uuid(),
      $1,
      $2,
      'application',
      lpad(n::text, 4, '0'),
      $3,
      $4,
      '{}',
      '2026-01-01'::timestamptz + n * interval '1 second'
    FROM
      generate_series(1, 237) n
  `,
    [f.org, project, digest, bytes.length],
  );

  await connect(page);
  await page.getByRole('link', { name: 'Releases', exact: true }).click();
  await page.getByRole('button', { name: 'Create release', exact: true }).click();
  await page.getByLabel('Search artifact options', { exact: true }).fill('0001');
  await page.getByLabel('Artifact', { exact: true }).selectOption({ label: 'application · 0001' });
  await page.getByLabel('Release version', { exact: true }).fill('retained-0001');

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create release', exact: true })
    .click();

  await expect(page.getByRole('dialog')).not.toBeVisible();

  const retained = (await db.query('SELECT * FROM releases WHERE organisation_id=$1', [f.org]))
    .rows[0];

  expect(
    (await db.query('SELECT version FROM artifacts WHERE id=$1', [retained.artifact_id])).rows[0]
      .version,
  ).toBe('0001');

  await db.query(
    `
    INSERT INTO
      releases (
        id,
        organisation_id,
        project_id,
        artifact_id,
        version,
        manifest,
        created_at
      )
    SELECT
      gen_random_uuid(),
      organisation_id,
      project_id,
      artifact_id,
      'newer-' || n,
      manifest,
      created_at + n * interval '1 second'
    FROM
      releases
      CROSS JOIN generate_series(1, 237) n
    WHERE
      id = $1
  `,
    [retained.id],
  );

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('tbody')).toContainText('newer-237');
  await page.getByLabel('Search releases', { exact: true }).fill('retained-0001');
  await page.getByRole('button', { name: /^Deploy retained-0001/ }).click();
  await expect(page.getByLabel('Release', { exact: true })).toHaveValue(retained.id);
  await expect(page.getByRole('dialog')).toContainText('Promotion policy satisfied.');

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Request deployment', exact: true })
    .click();

  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('tbody')).toContainText('retained-0001');
  await expect(page.locator('tbody')).toContainText('Waiting for agent');
});

test('configures signed webhooks and shows failed, retried and delivered attempts', async ({
  page,
}) => {
  const oldKey = process.env.KEEL_CREDENTIAL_KEY;
  const oldOrigins = process.env.KEEL_NOTIFICATION_ORIGINS;
  const key = randomBytes(32).toString('base64');

  process.env.KEEL_CREDENTIAL_KEY = key;
  process.env.KEEL_NOTIFICATION_ORIGINS = 'https://receiver.example';

  try {
    await connect(page);
    await page.getByRole('link', { name: 'Notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Add destination', exact: true }).click();
    await expect(page.getByLabel('Destination name', { exact: true })).toBeFocused();
    await page.getByLabel('Destination name', { exact: true }).fill('Release alerts');

    await page
      .getByLabel('Webhook URL', { exact: true })
      .fill('https://receiver.example/private-hook');

    await page
      .getByLabel('Signing secret', { exact: true })
      .fill('a-random-test-signing-secret-with-32-characters');

    await page.getByRole('checkbox', { name: 'queued', exact: true }).check();
    await page.getByRole('button', { name: 'Save destination', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Release alerts', exact: true })).toBeVisible();
    const principal = await control.authenticate(f.operator.token);
    const { transaction } = await import('../../packages/database/src/index.js');

    await transaction(db, async (tx) => {
      const project = await control.project(tx, principal, {
        name: 'Notification app',
        slug: 'notification-app',
        description: '',
      });

      const bytes = Buffer.from('notification browser test');

      const artifact = await control.artifact(
        tx,
        principal,
        { project_id: project.id, name: 'application', version: '1.0', digest: sha256(bytes) },
        bytes,
      );

      const release = await control.release(tx, principal, {
        project_id: project.id,
        artifact_id: artifact.id,
        version: '1.0',
        process: deploymentProcess(),
      });

      await control.deploy(tx, principal, {
        release_id: release.id,
        environment_id: f.environments.staging,
      });
    });

    await new NotificationWorker(
      db,
      new CredentialVault(key, 'notifications'),
      async () => ({ status: 400 }),
      ['https://receiver.example'],
    ).runOnce();

    await page.getByRole('button', { name: 'Refresh notifications', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'failed', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'View attempts', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'HTTP_ERROR', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry delivery', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'pending', exact: true })).toBeVisible();

    await new NotificationWorker(
      db,
      new CredentialVault(key, 'notifications'),
      async () => ({ status: 204 }),
      ['https://receiver.example'],
    ).runOnce();

    await page.getByRole('button', { name: 'Refresh notifications', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'delivered', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'ACCEPTED', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Disabled', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });

    const violations = (
      await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    ).violations;

    expect(violations).toEqual([]);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await page.screenshot({ path: 'output/playwright/notifications-mobile.png', fullPage: true });
    await connect(page, f.reader.token);
    await page.getByRole('link', { name: 'Notifications', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add destination', exact: true })).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'delivered', exact: true })).toBeVisible();
  } finally {
    if (oldKey === undefined) {
      delete process.env.KEEL_CREDENTIAL_KEY;
    } else {
      process.env.KEEL_CREDENTIAL_KEY = oldKey;
    }

    if (oldOrigins === undefined) {
      delete process.env.KEEL_NOTIFICATION_ORIGINS;
    } else {
      process.env.KEEL_NOTIFICATION_ORIGINS = oldOrigins;
    }
  }
});

test('publishes, reviews and independently approves a bounded runbook', async ({
  page,
  browser,
}) => {
  const p = await control.authenticate(f.operator.token);

  const mutate = <T>(work: Parameters<ControlPlane['mutate']>[3]) =>
    control.mutate(p, randomUUID(), randomUUID(), work) as Promise<T>;

  const project = await mutate<{ id: string }>((tx) =>
    control.project(tx, p, { name: 'Task project', slug: 'tasks', description: '' }),
  );

  const bytes = Buffer.from('retained task image');

  await mutate((tx) =>
    control.artifact(
      tx,
      p,
      { project_id: project.id, name: 'Task image', version: '1', digest: sha256(bytes) },
      bytes,
    ),
  );

  const execution = new ExecutionService(control);

  const agent = await mutate<{ id: string }>((tx) =>
    execution.registerAgent(tx, p, {
      name: 'Task agent',
      certificate_fingerprint: randomBytes(32).toString('hex'),
    }),
  );

  await mutate((tx) =>
    execution.registerTarget(tx, p, {
      project_id: project.id,
      environment_id: f.environments.staging,
      agent_id: agent.id,
      name: 'Task target',
      labels: {},
    }),
  );

  await connect(page);
  await page.getByRole('link', { name: 'Runbooks', exact: true }).click();
  await page.getByRole('button', { name: 'New runbook', exact: true }).click();
  await page.getByLabel('Runbook project', { exact: true }).selectOption(project.id);

  await page
    .getByLabel('Runbook environment', { exact: true })
    .selectOption(f.environments.staging);

  await page.getByLabel('Runbook name', { exact: true }).fill('Cache check');
  await page.getByLabel('Runbook slug', { exact: true }).fill('cache-check');
  await page.getByRole('button', { name: 'Create runbook', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cache check', exact: true })).toBeVisible();

  await page.getByLabel('Runbook YAML', { exact: true }).fill(
    JSON.stringify({
      apiVersion: 'keel.dev/v1alpha1',
      kind: 'Runbook',
      spec: {
        artifact: { dockerImageId: `sha256:${'a'.repeat(64)}` },
        task: { command: ['/bin/true'], timeoutSeconds: 15 },
      },
    }),
  );

  await page.getByRole('button', { name: 'Publish version', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Version 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review task', exact: true }).click();

  await expect(
    page.getByText('A different actor must approve this run.', { exact: false }),
  ).toBeVisible();

  await expect(page.getByRole('button', { name: 'Request run', exact: true })).toBeDisabled();

  await page
    .getByLabel(
      'I reviewed this command and understand that cancellation cannot undo external effects.',
    )
    .check();

  await page.getByRole('button', { name: 'Request run', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: 'Cache check · version 1', exact: true }),
  ).toBeVisible();

  await expect(page.getByRole('button', { name: 'Approve run', exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/runbooks-mobile.png', fullPage: true });
  const context = await browser.newContext();
  const approver = await context.newPage();

  approver.on('pageerror', (error) => errors.push(error.message));

  try {
    await connect(approver, f.approver.token);
    await approver.getByRole('link', { name: 'Runbooks', exact: true }).click();
    await approver.getByRole('button', { name: 'Review run', exact: true }).click();
    await expect(approver.getByRole('button', { name: 'Approve run', exact: true })).toBeDisabled();

    await approver
      .getByLabel(
        'I reviewed the fixed command, target and secret versions and approve its external effects.',
      )
      .check();

    await approver.getByRole('button', { name: 'Approve run', exact: true }).click();
    await expect(approver.getByRole('status').filter({ hasText: 'queued' })).toBeVisible();
    await approver.screenshot({ path: 'output/playwright/runbooks-desktop.png', fullPage: true });
  } finally {
    await context.close();
  }

  await page.getByRole('button', { name: 'Refresh runbooks', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'cancelled' })).toBeVisible();
});
