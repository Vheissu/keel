import { bindable, queueTask } from 'aurelia';
import type { Environment, Project } from '../../../packages/domain/src/index';
import { Api } from './api';

interface Secret {
  id: string;
  name: string;
  revision: number;
  current_version: number;
  disabled: boolean;
  updated_at: string;
}

export class SecretsPanel {
  @bindable api!: Api;
  @bindable projects: Project[] = [];
  @bindable environments: Environment[] = [];
  @bindable canManage = false;
  projectId = '';
  environmentId = '';
  secrets: Secret[] = [];
  selected: Secret | null = null;
  mode: 'create' | 'rotate' | 'revoke' | '' = '';
  name = '';
  value = '';
  acknowledged = false;
  busy = false;
  error = '';
  notice = '';
  heading!: HTMLElement;
  addButton!: HTMLButtonElement;
  private revision = 0;
  private returnFocus: HTMLElement | null = null;

  async binding() {
    this.projectId = this.projects[0]?.id ?? '';
    this.environmentId = this.environments[0]?.id ?? '';
    await this.load();
  }

  unbinding() {
    this.revision++;
    this.value = '';
  }

  async load() {
    const revision = ++this.revision;

    this.mode = '';
    this.value = '';
    this.secrets = [];
    this.error = '';

    if (!this.projectId || !this.environmentId) {
      return;
    }

    this.busy = true;

    try {
      const query = new URLSearchParams({
        project_id: this.projectId,
        environment_id: this.environmentId,
      });

      const secrets = await this.api.request<Secret[]>(`/secrets?${query}`);

      if (revision === this.revision) {
        this.secrets = secrets;
      }
    } catch (error) {
      if (revision === this.revision) {
        this.error = error instanceof Error ? error.message : 'Could not load secret metadata.';
      }
    } finally {
      if (revision === this.revision) {
        this.busy = false;
      }
    }
  }

  edit(mode: 'create' | 'rotate' | 'revoke', secret: Secret | null = null) {
    this.returnFocus = document.activeElement as HTMLElement;
    this.selected = secret;
    this.mode = mode;
    this.name = secret?.name ?? '';
    this.value = '';
    this.acknowledged = false;
    this.error = '';
    this.notice = '';
    queueTask(() => this.heading?.focus());
  }

  close() {
    this.mode = '';
    this.value = '';
    queueTask(() => this.returnFocus?.focus());
  }

  async save() {
    if (
      this.busy ||
      !this.canManage ||
      !this.mode ||
      (this.mode === 'revoke' && !this.acknowledged)
    ) {
      return;
    }

    this.busy = true;
    this.error = '';
    const value = this.value;
    const mode = this.mode;
    const name = this.name;

    this.value = '';

    try {
      if (mode === 'create') {
        await this.api.request('/secrets', 'POST', {
          project_id: this.projectId,
          environment_id: this.environmentId,
          name,
          value,
        });
      } else if (this.selected) {
        await this.api.request(
          `/secrets/${this.selected.id}/${mode === 'rotate' ? 'versions' : 'revoke'}`,
          'POST',
          {
            expected_revision: this.selected.revision,
            ...(mode === 'rotate' ? { value } : {}),
          },
        );
      }

      this.notice =
        mode === 'revoke'
          ? `${name} revoked. Existing containers keep values already delivered; rotate the credential at its source too.`
          : `${name} saved. Its value cannot be read back. New deployment requests use this version.`;

      this.close();
      await this.load();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not save the secret.';
    } finally {
      this.busy = false;

      if (!this.mode) {
        queueTask(() =>
          (this.returnFocus?.isConnected ? this.returnFocus : this.addButton)?.focus(),
        );
      }
    }
  }

  date(value: string) {
    return new Date(value).toLocaleString();
  }
}
