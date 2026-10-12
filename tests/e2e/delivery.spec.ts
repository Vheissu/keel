import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { fixture, testDatabaseUrl } from '../fixtures.js';
import { migrate } from '../../packages/database/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
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

test.beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-e2e-'));
  const control = new ControlPlane(db, new LocalArtifactStore(root));

  const integrations = new IntegrationService(
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
  app = await createApp(control, false, integrations);
  await app.listen({ host: '127.0.0.1', port: 4051 });
  await mkdir('output/playwright', { recursive: true });
});

test.beforeEach(async ({ page }) => {
  f = await fixture(db);
  errors = [];
  github = githubFixture();
  bitbucket = bitbucketFixture();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test.afterAll(async () => {
  await app.close();
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
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();

  await page
    .getByLabel('Environment', { exact: true })
    .selectOption({ label: 'Production · approval required' });

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Request deployment', exact: true })
    .click();

  await expect(page.getByText('Awaiting approval', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  const context = await browser.newContext();
  const approver = await context.newPage();

  await connect(approver, f.approver.token);
  await approver.getByRole('link', { name: /Deployments/ }).click();
  await approver.getByRole('button', { name: 'Approve', exact: true }).click();
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
  await page.getByRole('button', { name: 'Import run', exact: true }).click();
  await page.getByLabel('Workflow run ID', { exact: true }).fill('9001');
  await page.getByRole('button', { name: 'Queue import', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Queued', exact: true })).toBeVisible();

  const retainedBytes = github.state.bytes;

  github.state.bytes = Buffer.from('tampered-download');
  await importWorker.runOnce();
  await page.getByRole('button', { name: 'Refresh imports', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Failed', exact: true })).toBeVisible();
  github.state.bytes = retainedBytes;
  await page.getByRole('button', { name: 'Retry import', exact: true }).click();
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
  await page.getByRole('button', { name: 'Create release', exact: true }).click();
  await page.getByLabel('Release version', { exact: true }).fill('2.0.0');

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
  await expect(page.getByRole('button', { name: 'Import run', exact: true })).toHaveCount(0);
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
  await page.getByRole('button', { name: 'Rotate credentials', exact: true }).click();
  await expect(page.getByLabel('Publishing secret', { exact: true })).toHaveValue('');

  await page
    .getByLabel('Bitbucket repository access token', { exact: true })
    .fill('bitbucket-browser-test-rotated-token');

  await page
    .getByLabel('Publishing secret', { exact: true })
    .fill('bitbucket-browser-publishing-secret-rotated');

  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/bitbucket-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.screenshot({ path: 'output/playwright/bitbucket-mobile.png', fullPage: true });
});
