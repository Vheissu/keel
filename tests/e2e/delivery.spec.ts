import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
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

const schema = `e2e_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
let app: FastifyInstance, root: string, f: Awaited<ReturnType<typeof fixture>>;
let errors: string[] = [];

test.beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-e2e-'));
  app = await createApp(new ControlPlane(db, new LocalArtifactStore(root)));
  await app.listen({ host: '127.0.0.1', port: 4051 });
  await mkdir('output/playwright', { recursive: true });
});

test.beforeEach(async ({ page }) => {
  f = await fixture(db);
  errors = [];
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
  await expect(page.getByRole('status')).toContainText('Artifact verified and retained.');
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
