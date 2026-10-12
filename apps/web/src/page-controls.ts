import { bindable, queueTask } from 'aurelia';
import type { ResourcePage } from './resource-page';

export class PageControls {
  @bindable pager!: ResourcePage<unknown>;
  @bindable label = 'Records';
  @bindable searchable = true;
  summary!: HTMLElement;

  async move(cursor = '') {
    await this.pager.navigate(cursor);
    queueTask(() => this.summary?.focus());
  }
}
