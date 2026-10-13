import {
  browserSupportsWebAuthn,
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { ResourcePage } from './resource-page';
import { Api, type Dashboard } from './api';
import { queueTask } from 'aurelia';
import { errorMessage, formatDate, sha256Hex } from './format';
import type {
  Deployment,
  Release,
  Project,
  Artifact,
  AuditEvent,
  Environment,
} from '../../../packages/domain/src/index';

const pages = [
  'Overview',
  'Projects',
  'Artifacts',
  'Releases',
  'Deployments',
  'Environments',
  'Secrets',
  'Targets',
  'Integrations',
  'Notifications',
  'Audit log',
  'Workspace access',
  'Account security',
] as const;

type Named = {
  project_name?: string;
  environment_name?: string;
  release_version?: string;
  actor_name?: string;
  prerequisite_name?: string;
};

type Row = (Project | Artifact | Release | Deployment | AuditEvent | Environment) & Named;

type Page = (typeof pages)[number];

interface Promotion {
  eligible: boolean;
  reason: string | null;
  promotion_from_environment_id: string | null;
  source_deployment_id: string | null;
  requires_approval: boolean;
  digest: string;
  secret_bindings: { variable: string; name: string; version: number | null; available: boolean }[];
}

interface SecretBinding {
  variable: string;
  name: string;
  version: number;
  revoked_at: string | null;
}

export class MyApp {
  api = new Api();
  pages = pages;
  page: Page = 'Overview';
  data: Dashboard | null = null;
  token = '';
  hosted = false;
  account: { id: string; name: string; email: string } | null = null;
  memberships: {
    id: string;
    name: string;
    role: string;
    sso_name?: string;
    sso_linked?: boolean;
  }[] = [];
  ssoWorkspace = '';
  ssoSessionWorkspace = '';

  get hasSso() {
    return this.memberships.some((member) => member.sso_name);
  }

  get selectedMembership() {
    return this.memberships.find((member) => member.id === this.selectedWorkspace);
  }

  async startSso(
    link = false,
    workspace = this.account ? this.selectedWorkspace : this.ssoWorkspace,
  ) {
    this.busy = true;
    this.error = '';

    try {
      const result = await this.api.auth<{ url: string }>('/sso/start', {
        workspace_id: workspace,
        link,
      });

      window.location.assign(result.url);
    } catch (error) {
      this.handleError(error);
      this.busy = false;
    }
  }

  selectedWorkspace = '';
  email = '';
  password = '';
  mfaChallenge = '';
  mfaCode = '';
  accountName = '';
  inviteToken = '';
  resetToken = '';
  invitation: { email: string; workspace: string; role: string; existing_account: boolean } | null =
    null;

  busy = false;
  loading = false;
  error = '';
  notice = '';
  list: ResourcePage<Row> | null = null;
  dialog!: HTMLDialogElement;
  main!: HTMLElement;
  form: 'project' | 'artifact' | 'release' | 'deploy' | '' = '';
  name = '';
  slug = '';
  description = '';
  projectId = '';
  artifactId = '';
  version = '';
  releaseId = '';
  environmentId = '';
  promotion: Promotion | null = null;
  checkingPromotion = false;
  promotionError = '';
  rollbackSource: Deployment | null = null;
  private promotionRevision = 0;
  private rollbackFocus: HTMLElement | null = null;
  files: FileList | null = null;
  process = '';
  inspected: Release | null = null;
  secretInspection: SecretBinding[] | null = null;
  private returnFocus: HTMLElement | null = null;
  private refreshRevision = 0;
  private hashChange = () => {
    this.readHash();

    if (/^#(?:accept-invite|reset-password)\?/.test(window.location.hash)) {
      this.data = null;
      this.list?.dispose();
      this.list = null;
      void this.loadAccount();
    }
  };

  binding() {
    this.api.onUnauthorized = (error) => {
      this.disconnect();
      this.error = error.message;
    };

    this.readHash();
    window.addEventListener('hashchange', this.hashChange);
    void this.loadAccount();
  }

  unbinding() {
    this.list?.dispose();
    window.removeEventListener('hashchange', this.hashChange);
    this.api.onUnauthorized = null;
  }

  // The app routes on the hash, so the skip link moves focus without navigating.
  skipToMain() {
    this.main.focus();
  }

  readHash() {
    const path = window.location.hash.slice(1).split('?')[0];
    const page = pages.find((p) => this.path(p) === path) || 'Overview';
    const changed = page !== this.page;

    this.page = page;
    this.rollbackSource = null;
    document.title = `Keel · ${this.page}`;

    if (changed || !this.list) {
      this.openList();
    }
  }

  openList() {
    this.list?.dispose();
    this.list = null;

    if (
      this.data &&
      ['Projects', 'Artifacts', 'Releases', 'Deployments', 'Environments', 'Audit log'].includes(
        this.page,
      )
    ) {
      const resource = this.page === 'Audit log' ? 'audit' : this.page.toLowerCase();

      this.list = new ResourcePage<Row>(this.api, resource, resource);
      void this.list.start();
    }
  }

  get query() {
    return this.list?.query || '';
  }

  path(page: string) {
    return page.toLowerCase().replaceAll(' ', '-');
  }

  go(page: Page) {
    window.location.hash = this.path(page);
  }

  get canWrite() {
    return this.data?.principal.permissions.includes('write') ?? false;
  }

  get canApprove() {
    return this.data?.principal.permissions.includes('approve') ?? false;
  }

  get heading() {
    return this.page === 'Overview' ? 'Delivery overview' : this.page;
  }

  get subtitle() {
    return {
      Overview: 'Track releases from artifact to environment.',
      Projects: 'The applications and services you deliver.',
      Artifacts: 'Verified build outputs, retained for future releases.',
      Releases: 'Immutable snapshots. The same artifact in every environment.',
      Deployments: 'Review approvals and track deployment requests.',
      Environments: 'Choose where releases go and who approves them.',
      Secrets: 'Manage credentials for one project and environment at a time.',
      Targets: 'Private agents, target state and verified deployment results.',
      Notifications: 'Delivery history and webhook destinations for deployment events.',
      Integrations: 'Connect existing CI workflows and retain their build artifacts.',
      'Audit log': 'A record of changes and the people behind them.',
      'Account security': 'Passkeys, authenticator protection and active browser sessions.',
      'Workspace access': 'Workspace members, invitations and API tokens.',
    }[this.page];
  }

  get projects() {
    return (this.list?.resource === 'projects' ? this.list.items : []) as (Project & Named)[];
  }

  get artifacts() {
    return (this.list?.resource === 'artifacts' ? this.list.items : []) as (Artifact & Named)[];
  }

  get releases() {
    return (this.list?.resource === 'releases' ? this.list.items : []) as (Release & Named)[];
  }

  get deployments() {
    return (this.list?.resource === 'deployments' ? this.list.items : []) as (Deployment & Named)[];
  }

  get audit() {
    return (this.list?.resource === 'audit' ? this.list.items : []) as AuditEvent[];
  }

  get environments() {
    return (this.list?.resource === 'environments' ? this.list.items : []) as Environment[];
  }

  get manifestText() {
    return JSON.stringify(this.inspected?.manifest, null, 2);
  }

  projectName(id: string) {
    return this.data?.projects.find((p) => p.id === id)?.name ?? id;
  }

  environmentName(id: string) {
    return this.data?.environments.find((e) => e.id === id)?.name ?? id;
  }

  releaseVersion(id: string) {
    return this.data?.releases.find((r) => r.id === id)?.version ?? id;
  }

  readonly date = formatDate;

  size(value: number) {
    if (value < 1024) {
      return `${value} B`;
    }

    if (value < 1024 ** 2) {
      return `${(value / 1024).toFixed(1)} KB`;
    }

    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }

  short(value: string) {
    return value.slice(0, 12);
  }

  statusLabel(value: string) {
    return (
      (
        {
          queued: 'Waiting for agent',
          awaiting_approval: 'Awaiting approval',
          running: 'Deploying',
          cancel_requested: 'Cancelling · cleanup pending',
          reconciliation_required: 'Reconciliation required',
          succeeded: 'Verified',
          failed: 'Failed',
          cancelled: 'Cancelled',
          rejected: 'Rejected',
        } as Record<string, string>
      )[value] ?? value
    );
  }

  environmentState(project: string, slug: string) {
    const d = this.data?.environment_states?.find(
      (row) => row.project_id === project && row.environment_slug === slug,
    );

    return d ? `${d.release_version} · ${this.statusLabel(d.status)}` : 'No deployment';
  }

  async loadAccount() {
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.split('?')[1] || '');
    const secret = params.get('token') || '';
    const sso = hash.startsWith('#sso?');

    if (sso) {
      this.mfaChallenge = params.get('challenge') || '';
      window.history.replaceState(null, '', '#account-security');
      this.page = 'Account security';
    }

    if (hash.startsWith('#accept-invite?')) {
      this.inviteToken = secret;
    }

    if (hash.startsWith('#reset-password?')) {
      this.resetToken = secret;
    }

    if (this.inviteToken || this.resetToken) {
      window.history.replaceState(null, '', '#overview');
    }

    try {
      await this.restoreAccount();

      if (this.inviteToken) {
        this.invitation = await this.api.auth('/invitation', { token: this.inviteToken });
      }

      if (this.account && !this.inviteToken && !this.resetToken) {
        await this.switchWorkspace();
      }

      if (sso && params.has('error')) {
        this.error =
          'SSO could not be completed. Sign in with your password, connect your SSO account in Account security, and try again.';
      } else if (sso && params.has('linked')) {
        this.notice = 'SSO account connected. You can now sign in with your workspace provider.';
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  async restoreAccount() {
    const result = await this.api.auth<{
      enabled: boolean;
      user: { id: string; name: string; email: string } | null;
      csrf?: string;
      sso_workspace?: string;
      memberships: {
        id: string;
        name: string;
        role: string;
        sso_name?: string;
        sso_linked?: boolean;
      }[];
    }>('/session');

    this.hosted = result.enabled;
    this.account = result.user;
    this.memberships = result.memberships;
    this.api.csrf = result.csrf || '';
    this.ssoSessionWorkspace = result.sso_workspace || '';

    if (result.sso_workspace) {
      this.selectedWorkspace = result.sso_workspace;
    }

    if (!this.memberships.some((member) => member.id === this.selectedWorkspace)) {
      this.selectedWorkspace = this.memberships[0]?.id || '';
    }
  }

  passkeysSupported =
    browserSupportsWebAuthn() &&
    !/^[\d.]+$/.test(location.hostname) &&
    !location.hostname.includes(':');

  async signInWithPasskey() {
    this.busy = true;
    this.error = '';

    try {
      const { options } = await this.api.auth<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        '/passkeys/options',
        {},
      );

      const response = await startAuthentication({ optionsJSON: options });

      const result = await this.api.auth<{ mfa_required?: boolean; challenge?: string }>(
        '/passkeys/login',
        { response },
      );

      if (result.mfa_required && result.challenge) {
        this.mfaChallenge = result.challenge;
        this.mfaCode = '';

        return;
      }

      await this.restoreAccount();

      if (!this.inviteToken) {
        await this.switchWorkspace();
      }
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  }

  async signIn() {
    this.busy = true;
    this.error = '';

    try {
      const result = await this.api.auth<{ mfa_required?: boolean; challenge?: string }>('/login', {
        email: this.email,
        password: this.password,
      });

      this.password = '';

      if (result.mfa_required && result.challenge) {
        this.mfaChallenge = result.challenge;
        this.mfaCode = '';

        return;
      }

      await this.restoreAccount();

      if (!this.inviteToken) {
        await this.switchWorkspace();
      }
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  }

  cancelMfa() {
    this.mfaChallenge = '';
    this.mfaCode = '';
    this.error = '';
  }

  async verifyMfa() {
    this.busy = true;
    this.error = '';

    try {
      await this.api.auth('/mfa/challenge', { challenge: this.mfaChallenge, code: this.mfaCode });
      this.mfaChallenge = '';
      await this.restoreAccount();

      if (!this.inviteToken) {
        await this.switchWorkspace();
      }
    } catch (error) {
      this.handleError(error);
    } finally {
      this.mfaCode = '';
      this.busy = false;
    }
  }

  async acceptInvitation() {
    this.busy = true;
    this.error = '';

    try {
      await this.api.auth('/accept', {
        token: this.inviteToken,
        ...(this.invitation?.existing_account
          ? {}
          : { name: this.accountName, password: this.password }),
      });

      this.password = '';
      this.inviteToken = '';
      this.invitation = null;
      await this.restoreAccount();
      await this.switchWorkspace();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  }

  async resetPassword() {
    this.busy = true;
    this.error = '';

    try {
      await this.api.auth('/reset-password', { token: this.resetToken, password: this.password });
      this.password = '';
      this.resetToken = '';
      this.disconnect();
      this.notice = 'Password changed. Sign in with your new password.';
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  }

  async switchWorkspace() {
    this.data = null;
    this.list?.dispose();
    this.list = null;
    this.close();
    this.rollbackSource = null;
    this.error = '';
    this.notice = '';
    this.api.token = '';
    this.api.workspaceId = this.selectedWorkspace;

    if (this.selectedWorkspace) {
      await this.refresh();
    }
  }

  async signOut() {
    try {
      if (this.account && !this.api.token) {
        await this.api.auth('/logout', {});
      }

      this.disconnect();
    } catch (error) {
      this.handleError(error);
    }
  }

  async connect() {
    this.api.workspaceId = '';
    this.api.token = this.token.trim();
    this.token = '';
    await this.refresh();
  }

  disconnect() {
    this.ssoSessionWorkspace = '';
    this.mfaChallenge = '';
    this.mfaCode = '';
    this.refreshRevision++;
    this.loading = false;
    this.api.token = '';
    this.api.workspaceId = '';
    this.api.csrf = '';
    this.account = null;
    this.memberships = [];
    this.close();
    this.data = null;
    this.error = '';
    this.notice = '';
    this.list?.dispose();
    this.list = null;
    this.rollbackSource = null;
    this.rollbackFocus = null;
  }

  async refresh() {
    const revision = ++this.refreshRevision;

    this.loading = true;
    this.error = '';

    try {
      const data = await this.api.snapshot();

      if (revision === this.refreshRevision) {
        this.data = data;

        if (this.list) {
          await this.list.load();
        } else {
          this.openList();
        }
      }
    } catch (error) {
      if (revision === this.refreshRevision) {
        this.handleError(error);
      }
    } finally {
      if (revision === this.refreshRevision) {
        this.loading = false;
      }
    }
  }

  // A 401 has already disconnected the session through api.onUnauthorized.
  handleError(error: unknown) {
    this.error = errorMessage(error, 'The request failed. Try again.');
  }

  open(form: typeof this.form, release?: Release) {
    this.secretInspection = null;
    this.form = form;
    this.error = '';
    this.inspected = null;
    this.name = '';
    this.slug = '';
    this.description = '';
    this.version = '';
    this.projectId = release?.project_id ?? this.data?.projects[0]?.id ?? '';
    this.artifactId = '';
    this.releaseId = release?.id ?? '';
    this.files = null;
    this.environmentId = this.data?.environments.find((e) => e.slug === 'staging')?.id ?? '';
    this.resetProcess();
    this.returnFocus = document.activeElement as HTMLElement;

    queueTask(() => {
      if (form === 'deploy') {
        this.releaseId = release?.id ?? '';
        void this.loadPromotion();
      }

      this.dialog.showModal();
      this.dialog.querySelector<HTMLElement>('form input,form select,form textarea')?.focus();
    });
  }

  async loadPromotion() {
    const revision = ++this.promotionRevision;

    this.promotion = null;
    this.promotionError = '';
    this.checkingPromotion = false;

    if (this.form !== 'deploy' || !this.releaseId || !this.environmentId) {
      return;
    }

    this.checkingPromotion = true;

    try {
      const promotion = await this.api.request<Promotion>(
        `/releases/${this.releaseId}/promotion?environment_id=${this.environmentId}`,
      );

      if (revision === this.promotionRevision) {
        this.promotion = promotion;
      }
    } catch (error) {
      if (revision === this.promotionRevision) {
        this.promotionError = errorMessage(error, 'Could not check promotion policy.');
      }
    } finally {
      if (revision === this.promotionRevision) {
        this.checkingPromotion = false;
      }
    }
  }

  openRollback(deployment: Deployment) {
    this.rollbackFocus = document.activeElement as HTMLElement;
    this.rollbackSource = deployment;
  }

  closeRollback() {
    this.rollbackSource = null;
    queueTask(() => this.rollbackFocus?.focus());
  }

  async rollbackRequested() {
    this.closeRollback();
    this.notice = 'Rollback requested through the environment’s deployment and approval policy.';
    await this.refresh();
  }

  inspect(release: Release) {
    this.secretInspection = null;
    this.inspected = release;
    this.form = '';
    this.returnFocus = document.activeElement as HTMLElement;
    this.dialog.showModal();
  }

  close() {
    const wasOpen = this.dialog?.open ?? false;

    this.dialog?.close();
    this.promotionRevision++;
    this.promotion = null;
    this.promotionError = '';
    this.form = '';
    this.inspected = null;
    this.secretInspection = null;

    if (wasOpen) {
      this.returnFocus?.focus();
    }

    this.returnFocus = null;
  }

  async inspectSecretVersions(deployment: Deployment) {
    const focus = document.activeElement as HTMLElement;

    this.busy = true;
    this.error = '';

    try {
      this.secretInspection = await this.api.request<SecretBinding[]>(
        `/deployments/${deployment.id}/secret-bindings`,
      );

      this.inspected = null;
      this.form = '';
      this.returnFocus = focus;
      this.dialog.showModal();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  }

  // Escape fires `cancel`; prevent the native close so a busy request keeps the dialog open.
  cancelDialog(event: Event) {
    event.preventDefault();

    if (!this.busy) {
      this.close();
    }
  }

  projectChanged() {
    this.artifactId = '';
    this.resetProcess();
    this.releaseId = '';
    void this.loadPromotion();
  }

  nameChanged() {
    if (this.form === 'project') {
      this.slug = this.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 63);
    }
  }

  resetProcess(artifact?: { name?: string }) {
    // JSON strings are valid YAML scalars, including unusual uploaded artifact names.
    this.process = `apiVersion: keel.dev/v1alpha1
kind: DeploymentProcess
metadata:
  name: application
spec:
  artifact:
    source: release
    name: ${JSON.stringify(artifact?.name ?? 'application')}
  environments:
    staging:
      strategy: rolling
      targetSelector:
        labels: { tier: staging }
    production:
      strategy: rolling
      requiresApproval: true
      targetSelector:
        labels: { tier: production }
`;
  }

  async submit() {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';

    try {
      if (this.form === 'project') {
        await this.api.request('/projects', 'POST', {
          name: this.name,
          slug: this.slug,
          description: this.description,
        });

        this.notice = 'Project created.';
        this.go('Projects');
      } else if (this.form === 'artifact') {
        const file = this.files?.[0];

        if (!file) {
          throw new Error('Choose an artifact file.');
        }

        if (file.size > 25 * 1024 * 1024) {
          throw new Error('Artifacts are limited to 25 MB in this foundation.');
        }

        const bytes = await file.arrayBuffer();

        const digest = await sha256Hex(bytes);

        const params = new URLSearchParams({
          project_id: this.projectId,
          name: this.name,
          version: this.version,
          digest,
        });

        await this.api.request(`/artifacts?${params}`, 'POST', bytes, digest);
        this.notice = 'Artifact verified and retained.';
        this.go('Artifacts');
      } else if (this.form === 'release') {
        await this.api.request('/releases', 'POST', {
          project_id: this.projectId,
          artifact_id: this.artifactId,
          version: this.version,
          process: this.process,
        });

        this.notice = 'Immutable release created.';
        this.go('Releases');
      } else if (this.form === 'deploy') {
        await this.api.request('/deployments', 'POST', {
          release_id: this.releaseId,
          environment_id: this.environmentId,
        });

        this.notice =
          'Deployment requested. Approval and target execution will follow the recorded policy.';

        this.go('Deployments');
      }

      this.close();
      await this.refresh();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  }

  async action(deployment: Deployment, action: 'approve' | 'reject' | 'cancel') {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';

    try {
      await this.api.request(`/deployments/${deployment.id}/${action}`, 'POST');

      const notices = {
        approve: 'Deployment approved and queued.',
        reject: 'Deployment rejected.',
        cancel: 'Cancellation requested. Active target work must finish cleanup.',
      };

      this.notice = notices[action];
      await this.refresh();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.busy = false;
    }
  }

  async download(id: string) {
    try {
      const url = URL.createObjectURL(await this.api.download(id));
      const a = document.createElement('a');

      a.href = url;
      a.download = `${id}.bin`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      this.handleError(error);
    }
  }
}
