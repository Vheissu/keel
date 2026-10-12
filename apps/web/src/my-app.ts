import { Api, type Dashboard } from './api';
import { queueTask } from 'aurelia';
import { errorMessage, formatDate, sha256Hex } from './format';
import type { Deployment, Release } from '../../../packages/domain/src/index';

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
  'Audit log',
] as const;

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
  busy = false;
  loading = false;
  error = '';
  notice = '';
  query = '';
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
  private hashChange = () => this.readHash();

  binding() {
    this.api.onUnauthorized = (error) => {
      this.disconnect();
      this.error = error.message;
    };

    this.readHash();
    window.addEventListener('hashchange', this.hashChange);
  }

  unbinding() {
    window.removeEventListener('hashchange', this.hashChange);
    this.api.onUnauthorized = null;
  }

  // The app routes on the hash, so the skip link moves focus without navigating.
  skipToMain() {
    this.main.focus();
  }

  readHash() {
    const path = window.location.hash.slice(1);

    this.page = pages.find((p) => this.path(p) === path) || 'Overview';
    this.query = '';
    this.rollbackSource = null;
    document.title = `Keel · ${this.page}`;
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
      Integrations: 'Connect existing CI workflows and retain their build artifacts.',
      'Audit log': 'A record of changes and the people behind them.',
    }[this.page];
  }

  get projects() {
    return this.data?.projects.filter((p) => this.matches(p.name, p.slug)) ?? [];
  }

  get artifacts() {
    return (
      this.data?.artifacts.filter((a) =>
        this.matches(a.name, a.version, this.projectName(a.project_id)),
      ) ?? []
    );
  }

  get releases() {
    return (
      this.data?.releases.filter((r) => this.matches(r.version, this.projectName(r.project_id))) ??
      []
    );
  }

  get deployments() {
    return (
      this.data?.deployments.filter((d) =>
        this.matches(
          this.projectName(d.project_id),
          this.environmentName(d.environment_id),
          this.statusLabel(d.status),
        ),
      ) ?? []
    );
  }

  get projectArtifacts() {
    return this.data?.artifacts.filter((a) => a.project_id === this.projectId) ?? [];
  }

  get projectReleases() {
    return this.data?.releases.filter((r) => r.project_id === this.projectId) ?? [];
  }

  get manifestText() {
    return JSON.stringify(this.inspected?.manifest, null, 2);
  }

  get hasMore() {
    const table = this.page === 'Audit log' ? 'audit_events' : this.page.toLowerCase();

    return (this.data?.totals[table] ?? 0) > (this.data?.limit ?? 200);
  }

  matches(...values: string[]) {
    return values.join(' ').toLowerCase().includes(this.query.toLowerCase());
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
    const environment = this.data?.environments.find((e) => e.slug === slug);

    const d = this.data?.deployments.find(
      (d) => d.project_id === project && d.environment_id === environment?.id,
    );

    return d
      ? `${this.releaseVersion(d.release_id)} · ${this.statusLabel(d.status)}`
      : 'No deployment';
  }

  async connect() {
    this.api.token = this.token.trim();
    this.token = '';
    await this.refresh();
  }

  disconnect() {
    this.refreshRevision++;
    this.loading = false;
    this.api.token = '';
    this.close();
    this.data = null;
    this.error = '';
    this.notice = '';
    this.query = '';
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
    this.resetArtifact();
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
    this.resetArtifact();
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

  resetArtifact() {
    this.artifactId = this.projectArtifacts[0]?.id ?? '';
  }

  resetProcess() {
    const artifact = this.data?.artifacts.find((a) => a.id === this.artifactId);

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
