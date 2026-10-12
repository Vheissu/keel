import { test, expect } from '@playwright/test';
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
import { identityAdmin } from '../../apps/operations/src/identity-admin.js';

const schema = `identity_e2e_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl });
const db = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
const origin = 'http://127.0.0.1:5174';
const password = 'a long and memorable password';
let app: FastifyInstance;
let root: string;
let control: ControlPlane;
let workspace: string;
let link: string;
let email: string;
let errors: string[] = [];

test.beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-identity-e2e-'));
  control = new ControlPlane(db, new LocalArtifactStore(root));
  await mkdir('output/playwright', { recursive: true });
});

test.beforeEach(async ({ page }) => {
  const f = await fixture(db);

  workspace = f.org;
  email = `owner-${randomUUID()}@example.com`;
  link = (await identityAdmin(db, ['invite-owner', workspace, email], origin)).link;
  app = await createApp(control, false, undefined, undefined, origin);
  await app.listen({ host: '127.0.0.1', port: 4051 });
  errors = [];
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

test('accepts invitations, manages membership and exercises the full token lifecycle', async ({
  page,
  browser,
}) => {
  await page.goto(link);
  await page.getByLabel('Your name', { exact: true }).fill('Workspace owner');
  await page.getByLabel('Password (at least 15 characters)', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account and join', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
  expect(page.url()).not.toContain('token=');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
  await page.getByRole('link', { name: 'Workspace access', exact: true }).click();
  await page.getByLabel('Invitation email').fill('operator@example.com');
  await page.getByLabel('Invitation role').selectOption('operator');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const invitation = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();

  member.on('pageerror', (error) => errors.push(error.message));
  await member.goto(invitation);
  await member.getByLabel('Your name', { exact: true }).fill('Delivery operator');
  await member.getByLabel('Password (at least 15 characters)', { exact: true }).fill(password);
  await member.getByRole('button', { name: 'Create account and join' }).click();
  await expect(member.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
  await member.getByRole('link', { name: 'Workspace access', exact: true }).click();
  await expect(member.getByRole('heading', { name: 'Members', exact: true })).toHaveCount(0);
  await member.getByLabel('Token name').fill('Release publisher');
  await member.getByRole('checkbox', { name: 'write', exact: true }).check();
  await member.getByRole('button', { name: 'Create API token', exact: true }).click();
  const original = await member.getByLabel('New API token', { exact: true }).inputValue();

  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/snapshot',
        headers: { authorization: `Bearer ${original}` },
      })
    ).statusCode,
  ).toBe(200);

  await member.getByRole('button', { name: 'Rotate token', exact: true }).click();
  const replacement = await member.getByLabel('New API token', { exact: true }).inputValue();

  expect(replacement).not.toBe(original);

  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/snapshot',
        headers: { authorization: `Bearer ${original}` },
      })
    ).statusCode,
  ).toBe(401);

  await member.getByRole('button', { name: 'Revoke token', exact: true }).click();
  await expect(member.getByRole('status').filter({ hasText: 'Token revoked.' })).toBeVisible();
  await expect(member.getByLabel('New API token', { exact: true })).toHaveCount(0);

  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/snapshot',
        headers: { authorization: `Bearer ${replacement}` },
      })
    ).statusCode,
  ).toBe(401);

  await page.reload();

  const row = page
    .getByRole('row')
    .filter({ hasText: 'operator@example.com' })
    .filter({ has: page.getByRole('button', { name: 'Save role', exact: true }) });

  await row.getByRole('combobox').selectOption('reader');
  await row.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Role updated.' })).toBeVisible();
  await member.reload();
  await member.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(member.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
  await expect(member.getByRole('button', { name: 'New project', exact: true })).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page }).analyze();

  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/workspace-access-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/workspace-access-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row).toHaveCount(0);
  await member.reload();

  await expect(
    member.getByText('You have no active workspace memberships.', { exact: false }),
  ).toBeVisible();

  await memberContext.close();
});

test('switches workspaces, signs out, signs back in and changes its password', async ({ page }) => {
  await page.goto(link);
  await page.getByLabel('Your name', { exact: true }).fill('Workspace owner');
  await page.getByLabel('Password (at least 15 characters)', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account and join' }).click();
  await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
  const second = await identityAdmin(db, ['create-workspace', 'Second workspace', email], origin);

  await page.goto(second.link);
  await page.getByRole('button', { name: `Accept invitation as ${email}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();

  await page
    .getByRole('combobox', { name: 'Workspace', exact: true })
    .selectOption({ label: 'Second workspace' });

  await expect(page.locator('.workspace')).toContainText('Second workspace');
  await page.getByRole('button', { name: 'Disconnect Workspace owner', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
  await page.getByRole('link', { name: 'Workspace access', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(password);

  await page
    .getByLabel('New password (at least 15 characters)', { exact: true })
    .fill('a replacement memorable password');

  await page.getByRole('button', { name: 'Change password and sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a replacement memorable password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
});
