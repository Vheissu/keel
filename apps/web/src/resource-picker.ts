import { bindable, BindingMode, queueTask } from 'aurelia';
import type { Api } from './api';
import { ResourcePage } from './resource-page';

interface Choice {
  id: string;
  name?: string;
  version?: string;
  project_id?: string;
  requires_approval?: boolean;
}

export class ResourcePicker {
  @bindable api!: Api;
  @bindable resource = 'projects';
  @bindable label = 'Project';
  @bindable inputId = '';
  @bindable projectId = '';
  @bindable state = '';
  @bindable optional = false;
  @bindable autofocus = false;
  @bindable({ mode: BindingMode.twoWay }) value = '';
  @bindable changed: (item?: Choice) => void = () => {};
  pager!: ResourcePage<Choice>;
  selected: Choice | null = null;
  ready = false;
  private revision = 0;

  binding() {
    void this.reload();
  }

  unbinding() {
    this.revision++;
    this.pager?.dispose();
  }

  projectIdChanged() {
    if (this.pager) {
      void this.reload();
    }
  }

  async valueChanged() {
    if (
      this.pager &&
      this.value &&
      !this.pager.items.some((item) => item.id === this.value) &&
      this.selected?.id !== this.value
    ) {
      const value = this.value;
      const revision = this.revision;

      try {
        const item = await this.api.request<Choice>(`/resources/${this.resource}/${value}`);

        if (revision === this.revision && value === this.value) {
          this.selected = item;
        }
      } catch {
        if (revision === this.revision) {
          this.pager.error = 'The selected record could not be loaded. Choose it again.';
        }
      }
    }
  }

  async reload() {
    const revision = ++this.revision;

    this.pager?.dispose();
    this.ready = false;
    this.selected = null;

    this.pager = new ResourcePage(this.api, this.resource, '', {
      ...(this.projectId ? { project_id: this.projectId } : {}),
      ...(this.state ? { state: this.state } : {}),
    });

    await this.pager.start();

    if (revision !== this.revision) {
      return;
    }

    if (!this.value && !this.optional) {
      this.value = this.pager.items[0]?.id || '';
      this.select();
    }

    this.selected = this.pager.items.find((item) => item.id === this.value) || null;
    await this.valueChanged();

    if (revision === this.revision) {
      this.ready = true;

      if (this.autofocus) {
        queueTask(() => document.getElementById(this.inputId)?.focus());
      }
    }
  }

  get pinned() {
    return this.selected &&
      this.selected.id === this.value &&
      !this.pager.items.some((item) => item.id === this.value)
      ? this.selected
      : null;
  }

  text(item: Choice) {
    if (this.resource === 'environments' && item.requires_approval) {
      return `${item.name} · approval required`;
    }

    return item.name && item.version
      ? `${item.name} · ${item.version}`
      : item.name || item.version || item.id;
  }

  select() {
    this.selected = this.value
      ? this.pager.items.find((item) => item.id === this.value) || this.selected
      : null;

    this.changed(this.selected || undefined);
  }
}
