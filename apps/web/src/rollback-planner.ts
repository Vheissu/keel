import { bindable, queueTask } from 'aurelia';
import type { Deployment } from '../../../packages/domain/src/index';
import { Api } from './api';
import { errorMessage, formatDate } from './format';

interface Candidate {
  deployment_id: string;
  release_id: string;
  version: string;
  digest: string;
  verified_at: string;
}

interface Plan {
  id: string;
  release_version: string;
  digest: string;
  target_name: string;
  agent_name: string;
  environment_name: string;
  requires_approval: boolean;
  warning: string;
  expires_at: string;
  health_path: string;
}

export class RollbackPlanner {
  @bindable api!: Api;
  @bindable source!: Deployment;
  @bindable closePlanner: () => void = () => {};
  @bindable requested: () => Promise<void> = async () => {};
  candidates: Candidate[] = [];
  candidateId = '';
  plan: Plan | null = null;
  acknowledged = false;
  busy = false;
  error = '';
  heading!: HTMLElement;
  private revision = 0;

  binding() {
    void this.load();
  }

  attached() {
    queueTask(() => this.heading?.focus());
  }

  unbinding() {
    this.revision++;
  }

  async load() {
    if (!this.source || !this.api) {
      return;
    }

    const revision = ++this.revision;

    this.plan = null;
    this.candidates = [];
    this.error = '';
    this.busy = true;

    try {
      const result = await this.api.request<{ candidates: Candidate[] }>(
        `/deployments/${this.source.id}/rollback-candidates`,
      );

      if (revision === this.revision) {
        this.candidates = result.candidates;
        this.candidateId = result.candidates[0]?.deployment_id ?? '';
      }
    } catch (error) {
      if (revision === this.revision) {
        this.error = errorMessage(error, 'Could not load rollback history.');
      }
    } finally {
      if (revision === this.revision) {
        this.busy = false;
      }
    }
  }

  changeCandidate() {
    this.plan = null;
    this.acknowledged = false;
    this.error = '';
  }

  async review() {
    if (!this.candidateId || this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';

    try {
      this.plan = await this.api.request<Plan>('/rollback-plans', 'POST', {
        source_deployment_id: this.source.id,
        candidate_deployment_id: this.candidateId,
      });

      this.acknowledged = false;
    } catch (error) {
      this.error = errorMessage(error, 'Could not plan the rollback.');
    } finally {
      this.busy = false;
    }
  }

  async request() {
    if (!this.plan || !this.acknowledged || this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';

    try {
      await this.api.request(`/rollback-plans/${this.plan.id}/request`, 'POST', {
        acknowledge_data_not_restored: this.acknowledged,
      });

      await this.requested();
    } catch (error) {
      this.error = errorMessage(error, 'Could not request the rollback.');
    } finally {
      this.busy = false;
    }
  }

  readonly date = formatDate;
}
