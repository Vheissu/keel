import { bindable, queueTask } from 'aurelia';
import type { Environment } from '../../../packages/domain/src/index';
import { Api } from './api';

export class EnvironmentPolicies {
  @bindable api!: Api;
  @bindable environments: Environment[] = [];
  @bindable canApprove = false;
  @bindable refreshWorkspace: () => Promise<void> = async () => {};
  selected: Environment | null = null;
  prerequisite = '';
  busy = false;
  error = '';
  notice = '';
  prerequisiteInput!: HTMLSelectElement;
  private returnFocus: HTMLElement | null = null;

  edit(environment: Environment) {
    this.returnFocus = document.activeElement as HTMLElement;
    this.selected = environment;
    this.prerequisite = environment.promotion_from_environment_id ?? '';
    this.error = '';
    this.notice = '';
    queueTask(() => this.prerequisiteInput?.focus());
  }

  close() {
    this.selected = null;
    this.returnFocus?.focus();
  }

  name(id: string | null) {
    return (
      this.environments.find((environment) => environment.id === id)?.name ?? 'No prerequisite'
    );
  }

  async save() {
    if (!this.selected || this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';

    try {
      await this.api.request(`/environments/${this.selected.id}/promotion-policy`, 'POST', {
        promotion_from_environment_id: this.prerequisite || null,
        expected_revision: this.selected.policy_revision,
      });

      this.notice =
        'Promotion policy saved for new deployment requests. Existing requests keep their recorded policy.';

      this.close();
      await this.refreshWorkspace();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not save the policy.';
    } finally {
      this.busy = false;

      if (!this.selected) {
        queueTask(() => this.returnFocus?.focus());
      }
    }
  }
}
