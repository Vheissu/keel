import { bindable, queueTask } from 'aurelia';
import type { Project } from '../../../packages/domain/src/index';
import { Api } from './api';

interface Connection {
  id: string;
  project_id: string;
  name: string;
  repository: string;
  workflow_id: string;
  branch: string;
  artifact_name: string;
  enabled: boolean;
}

interface Import {
  id: string;
  connection_id: string;
  run_id: string;
  run_attempt: number;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  attempts: number;
  error_message: string | null;
  artifact_id: string | null;
  available_at: string;
  created_at: string;
}

interface IntegrationSnapshot {
  connections: Connection[];
  imports: Import[];
  configured: boolean;
  limit: number;
}

export class IntegrationsPanel {
  @bindable api!: Api;
  @bindable projects: Project[] = [];
  @bindable canWrite = false;
  @bindable refreshWorkspace!: () => Promise<void>;

  data: IntegrationSnapshot | null = null;
  loading = false;
  busy = false;
  error = '';
  notice = '';
  dialog!: HTMLDialogElement;
  form: 'connect' | 'import' | 'rotate' | '' = '';
  selected: Connection | null = null;
  name = '';
  projectId = '';
  repository = '';
  workflowId = '';
  branch = 'main';
  artifactName = 'application';
  providerToken = '';
  webhookSecret = '';
  runId = '';
  runAttempt = 1;
  private revision = 0;
  private returnFocus: HTMLElement | null = null;

  binding() {
    return this.refresh();
  }

  unbinding() {
    this.revision++;
    this.providerToken = '';
    this.webhookSecret = '';
    this.dialog?.close();
  }

  get formTitle() {
    const titles = {
      connect: 'Connect GitHub Actions',
      import: 'Import a workflow artifact',
      rotate: 'Rotate connection credentials',
    };

    return this.form ? titles[this.form] : '';
  }

  projectName(id: string) {
    return this.projects.find((project) => project.id === id)?.name ?? id;
  }

  connectionName(id: string) {
    return this.data?.connections.find((connection) => connection.id === id)?.name ?? id;
  }

  webhookUrl(connection: Connection) {
    return new URL(`/webhooks/github/${connection.id}`, window.location.origin).toString();
  }

  date(value: string) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );
  }

  statusLabel(status: Import['status']) {
    return { pending: 'Queued', processing: 'Importing', succeeded: 'Retained', failed: 'Failed' }[
      status
    ];
  }

  async refresh() {
    const revision = ++this.revision;

    this.loading = true;
    this.error = '';

    try {
      const data = await this.api.request<IntegrationSnapshot>('/integrations');

      if (revision === this.revision) {
        this.data = data;
      }
    } catch (error) {
      if (revision === this.revision) {
        this.error = error instanceof Error ? error.message : 'Connections could not be loaded.';
      }
    } finally {
      if (revision === this.revision) {
        this.loading = false;
      }
    }
  }

  open(form: typeof this.form, connection: Connection | null = null) {
    this.returnFocus = document.activeElement as HTMLElement;
    this.form = form;
    this.selected = connection;
    this.name = '';
    this.projectId = this.projects[0]?.id ?? '';
    this.repository = '';
    this.workflowId = '';
    this.branch = 'main';
    this.artifactName = 'application';
    this.providerToken = '';
    this.webhookSecret = '';
    this.runId = '';
    this.runAttempt = 1;
    this.error = '';

    queueTask(() => {
      this.dialog.showModal();
      this.dialog.querySelector<HTMLElement>('input, select')?.focus();
    });
  }

  close(force = false) {
    if (this.busy && !force) {
      return;
    }

    this.dialog.close();
    this.form = '';
    this.providerToken = '';
    this.webhookSecret = '';
    this.returnFocus?.focus();
  }

  cancel(event: Event) {
    event.preventDefault();
    this.close();
  }

  async submit() {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';

    try {
      if (this.form === 'connect') {
        await this.api.request('/integrations/github', 'POST', {
          name: this.name,
          project_id: this.projectId,
          repository: this.repository,
          workflow_id: this.workflowId,
          branch: this.branch,
          artifact_name: this.artifactName,
          token: this.providerToken,
          webhook_secret: this.webhookSecret,
        });

        this.notice =
          'GitHub Actions connected. Add the webhook in your repository to import successful runs.';
      } else if (this.form === 'rotate' && this.selected) {
        await this.api.request(`/integrations/${this.selected.id}/credentials`, 'POST', {
          token: this.providerToken,
          webhook_secret: this.webhookSecret,
        });

        this.notice = 'Credentials rotated. Update the webhook secret in GitHub to match.';
      } else if (this.form === 'import' && this.selected) {
        await this.api.request(`/integrations/${this.selected.id}/imports`, 'POST', {
          run_id: this.runId,
          run_attempt: Number(this.runAttempt),
        });

        this.notice = 'Import queued. Refresh to check its progress.';
      }

      this.close(true);
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'The connection could not be updated.';
    } finally {
      this.busy = false;
    }
  }

  async toggle(connection: Connection) {
    await this.perform(
      `/integrations/${connection.id}/state`,
      { enabled: !connection.enabled },
      connection.enabled ? 'Connection disabled.' : 'Connection enabled.',
    );
  }

  async retry(job: Import) {
    await this.perform(`/imports/${job.id}/retry`, {}, 'Import queued for another attempt.');
  }

  private async perform(path: string, body: unknown, notice: string) {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';

    try {
      await this.api.request(path, 'POST', body);
      this.notice = notice;
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'The request could not be completed.';
    } finally {
      this.busy = false;
    }
  }
}
