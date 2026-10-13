import { authenticatorCode } from '../authenticator.js';
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
let origin = 'http://127.0.0.1:5174';
const password = 'a long and memorable password';
let app: FastifyInstance;
let root: string;
let control: ControlPlane;
let workspace: string;
let link: string;
let email: string;
let errors: string[] = [];

test.beforeAll(async () => {
  process.env.KEEL_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString('base64');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(db);
  root = await mkdtemp(join(tmpdir(), 'keel-identity-e2e-'));
  control = new ControlPlane(db, new LocalArtifactStore(root));
  await mkdir('output/playwright', { recursive: true });
});

test.beforeEach(async ({ page }, testInfo) => {
  origin = testInfo.title.includes('enrolls a passkey')
    ? 'http://localhost:5174'
    : 'http://127.0.0.1:5174';

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

test('enrolls MFA, signs in with an authenticator and recovery code, and revokes another browser', async ({
  page,
  browser,
}) => {
  await page.goto(link);
  await page.getByLabel('Your name', { exact: true }).fill('Security owner');
  await page.getByLabel('Password (at least 15 characters)', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account and join' }).click();
  await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();

  const extraWorkspace = await identityAdmin(
    db,
    ['create-workspace', 'Security workspace', email],
    origin,
  );

  await page.goto(extraWorkspace.link);
  await page.getByRole('button', { name: `Accept invitation as ${email}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();

  await page
    .getByRole('combobox', { name: 'Workspace', exact: true })
    .selectOption(extraWorkspace.workspace_id);

  await expect(page.locator('.workspace')).toContainText('Security workspace');
  await page.getByRole('link', { name: 'Account security', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  const setupKey = await page.getByLabel('Authenticator setup key').inputValue();

  await page
    .getByLabel('Authenticator code', { exact: true })
    .fill(authenticatorCode(setupKey, -1));

  let releaseConfirmation!: () => void;
  let confirmationStarted!: () => void;

  const held = new Promise<void>((resolve) => {
    releaseConfirmation = resolve;
  });

  const started = new Promise<void>((resolve) => {
    confirmationStarted = resolve;
  });

  await page.route('**/api/auth/mfa/confirm', async (route) => {
    confirmationStarted();
    await held;
    await route.continue();
  });

  await page.getByRole('button', { name: 'Enable MFA', exact: true }).click();
  await started;
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(workspace);
  await expect(page.locator('.workspace')).toContainText('Test workspace');
  releaseConfirmation();
  const saved = await page.getByLabel('Recovery codes', { exact: true }).inputValue();
  const codes = saved.split('\n');

  expect(codes).toHaveLength(10);
  await expect(page.getByRole('status')).toContainText('MFA enabled');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'I saved my codes', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/account-security-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/account-security-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const context = await browser.newContext();
  const second = await context.newPage();

  second.on('pageerror', (error) => errors.push(error.message));
  await second.goto('/');
  await second.getByLabel('Email', { exact: true }).fill(email);
  await second.getByLabel('Password', { exact: true }).fill(password);
  await second.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(second.getByRole('heading', { name: 'Your delivery pipeline' })).toHaveCount(0);
  await expect(second.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);

  await second
    .getByLabel('Authenticator or recovery code', { exact: true })
    .fill(authenticatorCode(setupKey));

  await second.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(second.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out session', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Sign out session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out session', exact: true })).toHaveCount(0);
  await second.reload();
  await expect(second.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await second.getByLabel('Email', { exact: true }).fill(email);
  await second.getByLabel('Password', { exact: true }).fill(password);
  await second.getByRole('button', { name: 'Sign in', exact: true }).click();
  await second.getByLabel('Authenticator or recovery code', { exact: true }).fill(codes[0]);
  await second.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(second.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await expect(page.getByText('9 recovery codes remaining.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out other sessions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out session', exact: true })).toHaveCount(0);
  await page.getByLabel('Current password', { exact: true }).fill(password);
  await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(codes[1]);
  await page.getByRole('button', { name: 'Disable MFA and sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await context.close();
});

test('connects SSO, enforces workspace policy and signs in through the provider', async ({
  page,
  browser,
}) => {
  const { oidcProvider } = await import('../oidc-provider.js');
  const { configureSso } = await import('../../apps/api/src/sso.js');
  const provider = await oidcProvider();

  provider.state.email = email;

  try {
    await configureSso(db, workspace, provider.config, origin);
    await page.goto(link);
    await page.getByLabel('Your name', { exact: true }).fill('SSO owner');
    await page.getByLabel('Password (at least 15 characters)', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Create account and join', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
    await page.getByRole('link', { name: 'Workspace access', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Require workspace SSO', exact: true }).check();
    await page.getByRole('button', { name: 'Save authentication policy', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('requires SSO');
    await page.getByRole('link', { name: 'Account security', exact: true }).click();
    await page.getByRole('button', { name: 'Connect SSO account', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('SSO account connected');

    await expect(
      page.getByRole('button', { name: 'Connect SSO account', exact: true }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign in with SSO', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
    await page.getByRole('link', { name: 'Workspace access', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Require workspace SSO', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Allow managed API tokens', exact: true }).uncheck();
    await page.getByLabel('Maximum session age (minutes)', { exact: true }).fill('30');
    await page.getByRole('button', { name: 'Save authentication policy', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Authentication policy saved');
    await page.reload();

    await expect(
      page.getByRole('checkbox', { name: 'Require workspace SSO', exact: true }),
    ).toBeChecked();

    await expect(
      page.getByRole('checkbox', { name: 'Allow managed API tokens', exact: true }),
    ).not.toBeChecked();

    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.screenshot({
      path: 'output/playwright/workspace-auth-policy-desktop.png',
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });

    await page.screenshot({
      path: 'output/playwright/workspace-auth-policy-mobile.png',
      fullPage: true,
    });

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    const context = await browser.newContext();
    const second = await context.newPage();

    second.on('pageerror', (error) => errors.push(error.message));
    await second.goto('/');
    await second.getByLabel('Email', { exact: true }).fill(email);
    await second.getByLabel('Password', { exact: true }).fill(password);
    await second.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(second.getByRole('alert')).toContainText('requires SSO');
    await second.getByRole('button', { name: 'Sign in with SSO', exact: true }).click();
    await expect(second.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
    await second.getByRole('button', { name: 'Disconnect SSO owner', exact: true }).click();
    await second.getByLabel('Workspace ID', { exact: true }).fill(workspace);
    await second.getByRole('button', { name: 'Sign in with SSO', exact: true }).click();
    await expect(second.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
    await context.close();
  } finally {
    await provider.close();
  }
});

test('completes Keel MFA after SSO before enabling both workspace requirements', async ({
  page,
}) => {
  const { oidcProvider } = await import('../oidc-provider.js');
  const { configureSso } = await import('../../apps/api/src/sso.js');
  const provider = await oidcProvider();

  provider.state.email = email;

  try {
    await configureSso(db, workspace, provider.config, origin);
    await page.goto(link);
    await page.getByLabel('Your name', { exact: true }).fill('MFA SSO owner');
    await page.getByLabel('Password (at least 15 characters)', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Create account and join', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your delivery pipeline' })).toBeVisible();
    await page.getByRole('link', { name: 'Account security', exact: true }).click();
    await page.getByRole('button', { name: 'Connect SSO account', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('SSO account connected');
    await page.getByLabel('Current password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
    const setupKey = await page.getByLabel('Authenticator setup key').inputValue();

    await page
      .getByLabel('Authenticator code', { exact: true })
      .fill(authenticatorCode(setupKey, -1));

    await page.getByRole('button', { name: 'Enable MFA', exact: true }).click();

    const codes = (await page.getByLabel('Recovery codes', { exact: true }).inputValue()).split(
      '\n',
    );

    await page.getByRole('button', { name: 'I saved my codes', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with SSO', exact: true }).click();

    await expect(
      page.getByRole('button', { name: 'Verify and sign in', exact: true }),
    ).toBeVisible();

    expect(page.url()).not.toContain('challenge=');
    await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(codes[0]);
    await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh sessions', exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: 'output/playwright/sso-account-security.png', fullPage: true });
    await page.getByRole('link', { name: 'Workspace access', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Require workspace SSO', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Require a Keel authenticator', exact: true }).check();
    await page.getByRole('button', { name: 'Save authentication policy', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Authentication policy saved');
  } finally {
    await provider.close();
  }
});

test('enrolls a passkey, signs in, completes MFA and removes the credential', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);

  await cdp.send('WebAuthn.enable');

  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(link);
  await page.getByLabel('Your name', { exact: true }).fill('Passkey owner');
  await page.getByLabel('Password (at least 15 characters)', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account and join', exact: true }).click();
  await page.getByRole('link', { name: 'Account security', exact: true }).click();
  await page.getByLabel('Password for passkey changes').fill(password);
  await page.getByLabel('Passkey name', { exact: true }).fill('Personal laptop');
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Passkey added.' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Personal laptop', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/passkeys-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/passkeys-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Disconnect Passkey owner' }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Passkeys', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Account security', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  const secret = await page.getByLabel('Authenticator setup key', { exact: true }).inputValue();

  await page.getByLabel('Authenticator code', { exact: true }).fill(authenticatorCode(secret));
  await page.getByRole('button', { name: 'Enable MFA', exact: true }).click();

  const recovery = (await page.getByLabel('Recovery codes', { exact: true }).inputValue()).split(
    '\n',
  )[0];

  await page.getByRole('button', { name: 'Disconnect Passkey owner' }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verify and sign in' })).toBeVisible();
  await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(recovery);
  await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Passkeys', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Account security', exact: true }).click();
  await page.getByLabel('Password for passkey changes').fill(password);
  await page.getByRole('button', { name: 'Remove passkey and sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Keel' })).toBeVisible();

  expect(
    (
      await db.query('SELECT 1 FROM passkeys p JOIN users u ON u.id=p.user_id WHERE u.email=$1', [
        email,
      ])
    ).rowCount,
  ).toBe(0);

  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
});
