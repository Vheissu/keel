import { bindable, queueTask } from 'aurelia';
import type { Environment, Project, Release } from '../../../packages/domain/src/index';
import { Api } from './api';

interface Agent {
  id: string;
  name: string;
  state: string;
  last_seen_at: string | null;
}

interface Target {
  id: string;
  name: string;
  project_id: string;
  environment_id: string;
  agent_id: string;
  current_state: string;
  current_release_id: string | null;
}

interface Attempt {
  id: string;
  deployment_id: string;
  target_id: string;
  state: string;
  fence: number;
  result_code: string | null;
}

interface Fleet {
  agents: Agent[];
  targets: Target[];
  attempts: Attempt[];
}

export class TargetsPanel {
  @bindable api!: Api;
  @bindable projects: Project[] = [];
  @bindable environments: Environment[] = [];
  @bindable releases: Release[] = [];
  @bindable canWrite = false;
  data: Fleet | null = null;
  busy = false;
  error = '';
  notice = '';
  form: 'agent' | 'target' | '' = '';
  name = '';
  nameInput!: HTMLInputElement;
  private returnFocus: HTMLElement | null = null;
  fingerprint = '';
  projectId = '';
  environmentId = '';
  agentId = '';
  labels = '{"app":"web","tier":"staging"}';
  private revision = 0;

  binding() {
    return this.refresh();
  }

  unbinding() {
    this.revision++;
  }

  async refresh() {
    const revision = ++this.revision;

    try {
      const data = await this.api.request<Fleet>('/execution');

      if (revision === this.revision) {
        this.data = data;
      }
    } catch (error) {
      if (revision === this.revision) {
        this.error = error instanceof Error ? error.message : 'Could not load targets.';
      }
    }
  }

  open(form: 'agent' | 'target') {
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.form = form;
    this.fingerprint = '';
    queueTask(() => this.nameInput?.focus());
    this.name = '';
    this.error = '';
    this.notice = '';
    this.projectId = this.projects[0]?.id ?? '';

    this.environmentId =
      this.environments.find((environment) => environment.slug === 'staging')?.id ??
      this.environments[0]?.id ??
      '';

    this.agentId = this.data?.agents.find((a) => a.state === 'active')?.id ?? '';
  }

  closeForm() {
    this.form = '';
    this.returnFocus?.focus();
  }

  async save() {
    this.busy = true;
    this.error = '';

    try {
      if (this.form === 'agent') {
        await this.api.request('/agents', 'POST', {
          name: this.name,
          certificate_fingerprint: this.fingerprint.replaceAll(':', '').toLowerCase().trim(),
        });

        this.notice = 'Agent registered. Add its certificate and key to the private host.';
      } else {
        await this.api.request('/targets', 'POST', {
          name: this.name,
          project_id: this.projectId,
          environment_id: this.environmentId,
          agent_id: this.agentId,
          labels: JSON.parse(this.labels),
        });

        this.notice = 'Target registered. Add its ID and ports to the agent’s local allowlist.';
      }

      this.closeForm();
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not save.';
    } finally {
      this.busy = false;
    }
  }

  async setState(agent: Agent, state: string) {
    this.busy = true;
    this.error = '';

    try {
      await this.api.request(`/agents/${agent.id}/state`, 'POST', { state });

      this.notice =
        state === 'revoked'
          ? 'Certificate revoked. Unfinished work stays locked for reconciliation.'
          : `Agent ${state}.`;

      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not update agent.';
    } finally {
      this.busy = false;
    }
  }

  label(value: string) {
    return value.replaceAll('_', ' ');
  }

  agentName(id: string) {
    return this.data?.agents.find((a) => a.id === id)?.name ?? id;
  }

  targetName(id: string) {
    return this.data?.targets.find((t) => t.id === id)?.name ?? id;
  }

  environmentName(id: string) {
    return this.environments.find((e) => e.id === id)?.name ?? id;
  }

  releaseVersion(target: Target) {
    if (target.current_state !== 'verified') {
      return 'Unknown';
    }

    return (
      this.releases.find((r) => r.id === target.current_release_id)?.version ??
      target.current_release_id
    );
  }

  date(value: string | null) {
    return value ? new Date(value).toLocaleString() : 'Not connected';
  }
}
