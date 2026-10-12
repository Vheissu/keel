import { ResourcePage } from './resource-page';
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
  pager: ResourcePage<Secret> | null = null;

  get secrets() {
    return this.pager?.items || [];
  }

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

  private hashChange = () => {
    void this.restoreScope();
  };

  binding() {
    window.addEventListener('hashchange', this.hashChange);
    void this.restoreScope(true);
  }

  private async restoreScope(initial = false) {
    const [path, search] = window.location.hash.split('?');
    const params = new URLSearchParams(search || '');
    const project = params.get('secrets.project') || this.projects[0]?.id || '';
    const environment = params.get('secrets.environment') || this.environments[0]?.id || '';

    if (initial || project !== this.projectId || environment !== this.environmentId) {
      this.projectId = project;
      this.environmentId = environment;

      if (initial) {
        params.set('secrets.project', project);
        params.set('secrets.environment', environment);
        window.history.replaceState(null, '', `${path}?${params}`);
      }

      await this.load();
    }
  }

  async scopeChanged() {
    const [path, search] = window.location.hash.split('?');
    const params = new URLSearchParams(search || '');

    params.set('secrets.project', this.projectId);
    params.set('secrets.environment', this.environmentId);
    params.delete('secrets.cursor');
    window.history.pushState(null, '', `${path}?${params}`);
    await this.load();
  }

  unbinding() {
    window.removeEventListener('hashchange', this.hashChange);
    this.revision++;
    this.pager?.dispose();
    this.value = '';
  }

  async load() {
    const revision = ++this.revision;

    this.mode = '';
    this.value = '';
    this.pager?.dispose();
    this.pager = null;
    this.error = '';

    if (!this.projectId || !this.environmentId) {
      return;
    }

    this.busy = true;

    try {
      this.pager = new ResourcePage<Secret>(this.api, 'secrets', 'secrets', {
        project_id: this.projectId,
        environment_id: this.environmentId,
      });

      await this.pager.start();
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
