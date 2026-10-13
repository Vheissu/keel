import { ResourcePage } from './resource-page';
import { bindable, queueTask } from 'aurelia';
import type { Environment, Project, Release } from '../../../packages/domain/src/index';
import { Api } from './api';
import { errorMessage, formatDate } from './format';

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
  capability: string;
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
  recovery: string | null;
  phase: string;
  phase_updated_at: string;
}

export class TargetsPanel {
  @bindable api!: Api;
  @bindable projects: Project[] = [];
  @bindable environments: Environment[] = [];
  @bindable releases: Release[] = [];
  @bindable canWrite = false;
  agents!: ResourcePage<Agent>;
  targets!: ResourcePage<Target>;
  attempts!: ResourcePage<Attempt>;

  get data() {
    return this.agents && this.targets && this.attempts
      ? { agents: this.agents.items, targets: this.targets.items, attempts: this.attempts.items }
      : null;
  }

  loading = false;
  busy = false;
  error = '';
  notice = '';
  form: 'agent' | 'target' | 'certificate' | '' = '';
  name = '';
  nameInput!: HTMLInputElement;
  private returnFocus: HTMLElement | null = null;
  fingerprint = '';
  replacementAgentId = '';
  stopped = false;
  projectId = '';
  environmentId = '';
  agentId = '';
  capability = 'docker-recreate-v1';
  labels = '{"app":"web","tier":"staging"}';
  private revision = 0;

  binding() {
    this.agents = new ResourcePage(this.api, 'agents', 'agents');
    this.targets = new ResourcePage(this.api, 'targets', 'targets');
    this.attempts = new ResourcePage(this.api, 'attempts', 'attempts');
    void Promise.all([this.agents.start(), this.targets.start(), this.attempts.start()]);
  }

  unbinding() {
    this.revision++;
    this.agents?.dispose();
    this.targets?.dispose();
    this.attempts?.dispose();
  }

  async refresh() {
    const revision = ++this.revision;

    this.loading = true;
    this.error = '';

    try {
      await Promise.all([this.agents.load(), this.targets.load(), this.attempts.load()]);
    } catch (error) {
      if (revision === this.revision) {
        this.error = errorMessage(error, 'Could not load targets.');
      }
    } finally {
      if (revision === this.revision) {
        this.loading = false;
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

  get formTitle() {
    const titles = {
      agent: 'Register a certificate',
      target: 'Register a deployment target',
      certificate: 'Replace agent certificate',
    };

    return this.form ? titles[this.form] : '';
  }

  replaceCertificate(agent: Agent) {
    this.open('agent');
    this.form = 'certificate';
    this.replacementAgentId = agent.id;
    this.stopped = false;
    this.name = agent.name;
  }

  closeForm() {
    this.form = '';
    this.returnFocus?.focus();
  }

  async save() {
    this.busy = true;
    this.error = '';

    try {
      if (this.form === 'certificate') {
        await this.api.request(`/agents/${this.replacementAgentId}/certificate`, 'POST', {
          certificate_fingerprint: this.fingerprint.replaceAll(':', '').toLowerCase().trim(),
          same_host_agent_stopped: this.stopped,
        });

        this.notice =
          'Certificate replaced. Start the agent on the same host to finish cleanup, then resume deployments.';
      } else if (this.form === 'agent') {
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
          capability: this.capability,
        });

        this.notice = 'Target registered. Add its ID and ports to the agent’s local allowlist.';
      }

      this.closeForm();
      await this.refresh();
    } catch (error) {
      this.error = errorMessage(error, 'Could not save.');
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
      this.error = errorMessage(error, 'Could not update agent.');
    } finally {
      this.busy = false;
    }
  }

  guidance(attempt: Attempt) {
    if (['reconciliation_required', 'reconciling'].includes(attempt.state)) {
      return 'Keep the agent on its original host with the same local or SSH target configuration. It must confirm cleanup before this target can deploy again.';
    }

    const messages: Record<string, string> = {
      HTTP_VERIFIED: 'The container matched this attempt and returned HTTP 200.',
      ARTIFACT_INVALID:
        'Check the retained artifact, ZIP entry path and pinned Docker image ID. Create a corrected release before retrying.',
      DOCKER_FAILED:
        'Check the Docker socket, SSH connection, available resources and target port before retrying.',
      HEALTH_FAILED: 'Check the application’s HTTP path and container port before retrying.',
      SECRET_UNAVAILABLE:
        'Check pinned secret versions and the gateway encryption key. Secret preflight failed before container replacement; submit a new request after resolving it.',
      RECONCILED:
        'Cleanup confirmed. The interrupted release did not succeed; request a new deployment when ready.',
      CANCELLED: 'Cancellation cleanup confirmed.',
      PRE_HOOK_FAILED:
        'The pre-deploy hook failed. The existing application was preserved. Check its command, image runtime and selected secrets before creating a new request.',
      PRE_HOOK_TIMEOUT:
        'The pre-deploy hook exceeded its time limit. The existing application was preserved. Check for partial external changes before retrying.',
      POST_HOOK_FAILED:
        'The post-deploy hook failed after application verification. Cleanup removed the candidate or restored the previous blue/green route. Check for partial external changes before retrying.',
      POST_HOOK_TIMEOUT:
        'The post-deploy hook exceeded its time limit. Check the cleanup outcome and any partial external changes before retrying.',
      HOOK_NETWORK_UNAVAILABLE:
        'A hook requested target networking, but the agent has no hook network configured. Configure the target’s Docker network before submitting a new request.',
      HOOK_STATE_FAILED:
        'The agent could not persist lifecycle state. Check its original state directory and available disk space before retrying.',
      AGENT_UNAVAILABLE:
        'The agent did not claim this deployment. Check its connection, certificate, draining state and support for the release’s secrets, hooks and target strategy.',
    };

    return (
      messages[attempt.result_code ?? ''] ??
      'Progress is reported by the agent. It does not confirm deployment success.'
    );
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
    return value ? formatDate(value) : 'Not connected';
  }
}
