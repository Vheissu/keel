import { bindable, queueTask } from 'aurelia';
import type {
  RunbookProcess,
  RunbookInput,
  RunbookInputValues,
} from '../../../packages/deployment-schema/src/index';
import { cronOccurrences } from '../../../packages/deployment-schema/src/runbook-schedule';
import type { RunbookRun } from '../../../packages/domain/src/index';
import { Api } from './api';
import { ResourcePage } from './resource-page';
import { errorMessage, formatDate } from './format';

interface Definition {
  id: string;
  name: string;
  project_id: string;
  environment_id: string;
  project_name: string;
  environment_name: string;
  revision: number;
}

interface Manifest {
  artifact: { digest: string; name: string; size: number };
  process: RunbookProcess;
}

interface Version {
  id: string;
  version: number;
  manifest: Manifest;
}

interface Review {
  input_values: RunbookInputValues;
  id: string;
  manifest: Manifest;
  version: number;
  target_name: string;
  environment_name: string;
  agent_name: string;
  requires_approval: boolean;
  expires_at: string;
  warning: string;
  secret_bindings: Binding[];
}

interface Binding {
  revoked_at?: string | null;
  variable: string;
  name: string;
  version: number;
}

interface Schedule {
  id: string;
  name: string;
  cron: string;
  time_zone: string;
  enabled: boolean;
  revision: number;
  next_run_at: string | null;
  paused_code: string | null;
  last_result_code: string | null;
  last_scheduled_for: string | null;
  runbook_name: string;
  runbook_version: number;
  environment_name: string;
  target_name: string;
  requires_approval: boolean;
  created_by: string;
  created_by_name: string;
}

function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface Run extends RunbookRun {
  runbook_schedule_id: string | null;
  scheduled_for: string | null;
  input_values: RunbookInputValues;
  runbook_name: string;
  runbook_version: number;
  manifest: Manifest;
  target_name: string;
  environment_name: string;
  phase: string | null;
  result_code: string | null;
}

export class RunbooksPanel {
  @bindable api!: Api;
  @bindable canWrite = false;
  @bindable canApprove = false;
  @bindable actorId = '';
  catalogue!: ResourcePage<Definition>;
  runs!: ResourcePage<Run>;
  schedules!: ResourcePage<Schedule>;
  versions: ResourcePage<Version> | null = null;
  selected: Definition | null = null;
  version: Version | null = null;
  review: Review | null = null;
  run: Run | null = null;
  bindings: Binding[] = [];
  inputFields: { name: string; definition: RunbookInput; value: string }[] = [];
  createOpen = false;
  projectId = '';
  environmentId = '';
  name = '';
  slug = '';
  artifactId = '';
  targetId = '';
  acknowledged = false;
  scheduleName = '';
  cron = '0 3 * * *';
  timeZone = localZone();
  busy = false;
  error = '';
  notice = '';
  detailHeading!: HTMLElement;
  process = `apiVersion: keel.dev/v1alpha1
kind: Runbook
spec:
  artifact:
    dockerImageId: sha256:${'0'.repeat(64)}
  task:
    command: ["/bin/task"]
    timeoutSeconds: 30
    network: none
  requiresApproval: true
`;
  private active = true;
  date = formatDate;

  binding() {
    this.catalogue = new ResourcePage(this.api, 'runbooks', 'runbooks');
    this.runs = new ResourcePage(this.api, 'runbook-runs', 'runbook-runs');
    this.schedules = new ResourcePage(this.api, 'runbook-schedules', 'runbook-schedules');
    void Promise.all([this.catalogue.start(), this.runs.start(), this.schedules.start()]);
  }

  unbinding() {
    this.active = false;
    this.catalogue.dispose();
    this.runs.dispose();
    this.schedules.dispose();
    this.versions?.dispose();
  }

  async perform(work: () => Promise<void>) {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';
    this.notice = '';

    try {
      await work();
    } catch (error) {
      if (this.active) {
        this.error = errorMessage(error, 'The runbook action failed.');
      }
    } finally {
      if (this.active) {
        this.busy = false;
      }
    }
  }

  async refresh() {
    await this.perform(async () => {
      await Promise.all([
        this.catalogue.load(),
        this.runs.load(),
        this.schedules.load(),
        this.versions?.load(),
      ]);

      if (this.run) {
        await this.readRun(this.run.id);
      }
    });
  }

  async create() {
    await this.perform(async () => {
      const definition = await this.api.request<Definition>('/runbooks', 'POST', {
        project_id: this.projectId,
        environment_id: this.environmentId,
        name: this.name,
        slug: this.slug,
      });

      if (!this.active) {
        return;
      }

      this.createOpen = false;
      this.name = '';
      this.slug = '';
      await this.catalogue.load();
      await this.select(definition);
    });
  }

  async select(definition: Definition) {
    this.selected = definition;
    this.version = null;
    this.inputFields = [];
    this.review = null;
    this.run = null;
    this.artifactId = '';
    this.targetId = '';
    this.acknowledged = false;
    this.versions?.dispose();

    this.versions = new ResourcePage(this.api, 'runbook-versions', '', {
      runbook_id: definition.id,
    });

    await this.versions.start();
    queueTask(() => this.detailHeading?.focus());
  }

  async publish() {
    await this.perform(async () => {
      if (!this.selected) {
        return;
      }

      const version = await this.api.request<Version>(
        `/runbooks/${this.selected.id}/versions`,
        'POST',
        {
          artifact_id: this.artifactId,
          process: this.process,
          expected_revision: this.selected.revision,
        },
      );

      if (!this.active) {
        return;
      }

      this.selected.revision = version.version;
      this.chooseVersion(version);
      await Promise.all([this.catalogue.load(), this.versions?.load()]);
      this.notice = `Version ${version.version} published. Review it with a target before requesting a run.`;
    });
  }

  chooseVersion(version: Version) {
    this.version = version;

    this.inputFields = Object.entries(version.manifest.process.spec.inputs ?? {}).map(
      ([name, definition]) => ({
        name,
        definition,
        value: definition.default === undefined ? '' : String(definition.default),
      }),
    );

    this.clearReview();
  }

  clearReview() {
    this.review = null;
    this.acknowledged = false;
  }

  async reviewTask() {
    await this.perform(async () => {
      if (!this.version) {
        return;
      }

      const review = await this.api.request<Review>('/runbook-plans', 'POST', {
        runbook_version_id: this.version.id,
        target_id: this.targetId,
        inputs: this.inputValues(),
      });

      if (!this.active) {
        return;
      }

      this.review = review;
      this.acknowledged = false;
    });
  }

  async requestRun() {
    if (!this.review || !this.acknowledged) {
      return;
    }

    await this.perform(async () => {
      const run = await this.api.request<Run>(`/runbook-plans/${this.review!.id}/request`, 'POST', {
        acknowledge_external_effects: true,
      });

      if (!this.active) {
        return;
      }

      this.review = null;
      await this.runs.load();
      await this.readRun(run.id);
      this.notice = 'Run requested. Refresh to follow its progress.';
    });
  }

  async createSchedule() {
    if (!this.review || !this.acknowledged) {
      return;
    }

    await this.perform(async () => {
      const schedule = await this.api.request<Schedule>('/runbook-schedules', 'POST', {
        runbook_plan_id: this.review!.id,
        name: this.scheduleName,
        cron: this.cron,
        time_zone: this.timeZone,
        acknowledge_external_effects: true,
      });

      if (!this.active) {
        return;
      }

      this.review = null;
      this.acknowledged = false;
      this.scheduleName = '';
      await this.schedules.load();
      this.notice = `Schedule ${schedule.name} created. Its first run is ${this.date(schedule.next_run_at!)}.`;
    });
  }

  async setSchedule(schedule: Schedule, enabled: boolean) {
    await this.perform(async () => {
      await this.api.request(`/runbook-schedules/${schedule.id}/state`, 'POST', {
        enabled,
        expected_revision: schedule.revision,
      });

      if (this.active) {
        await this.schedules.load();
      }
    });
  }

  // Previews use the browser's time zone data; the server's next run time is authoritative.
  get schedulePreview(): { times: string[]; error: string } {
    try {
      const times = cronOccurrences(this.cron, this.timeZone, new Date(), 3);

      // dateStyle and timeStyle cannot be combined with timeZoneName.
      const format = new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: this.timeZone,
        timeZoneName: 'short',
      });

      return {
        times: times.map((date) => format.format(date)),
        error: times.length ? '' : 'This schedule never runs.',
      };
    } catch (error) {
      return { times: [], error: errorMessage(error, 'Enter a valid schedule.') };
    }
  }

  scheduleState(schedule: Schedule) {
    if (schedule.enabled) {
      return `Next ${this.date(schedule.next_run_at!)}`;
    }

    return schedule.paused_code ? `Paused · ${schedule.paused_code}` : 'Stopped';
  }

  async readRun(id: string) {
    const [run, result] = await Promise.all([
      this.api.request<Run>(`/resources/runbook-runs/${id}`),
      this.api.request<{ items: Binding[] } | Binding[]>(`/runbook-runs/${id}/secret-bindings`),
    ]);

    if (!this.active) {
      return;
    }

    this.run = run;
    this.bindings = Array.isArray(result) ? result : result.items;
    this.selected = null;
    this.review = null;
    this.acknowledged = false;
    queueTask(() => this.detailHeading?.focus());
  }

  async inspectRun(run: Run) {
    await this.perform(() => this.readRun(run.id));
  }

  async transition(action: 'approve' | 'reject' | 'cancel') {
    if (!this.run || (action === 'approve' && !this.acknowledged)) {
      return;
    }

    await this.perform(async () => {
      const id = this.run!.id;

      await this.api.request(
        `/runbook-runs/${id}/${action}`,
        'POST',
        action === 'approve' ? { acknowledge_external_effects: true } : {},
      );

      await Promise.all([this.runs.load(), this.readRun(id)]);
    });
  }

  get manifest() {
    return this.run?.manifest || this.version?.manifest;
  }

  get command() {
    return JSON.stringify(this.manifest?.process.spec.task.command, null, 2);
  }

  inputValues(): RunbookInputValues {
    const values: RunbookInputValues = {};

    for (const field of this.inputFields) {
      if (field.value === '' && field.definition.type !== 'string') {
        continue;
      }

      if (field.definition.type === 'integer') {
        values[field.name] = Number(field.value);
      } else if (field.definition.type === 'boolean') {
        values[field.name] = field.value === 'true';
      } else {
        values[field.name] = field.value;
      }
    }

    return values;
  }

  get reviewedInputs() {
    return Object.entries(this.review?.input_values ?? this.run?.input_values ?? {}).map(
      ([name, value]) => ({
        name,
        value: JSON.stringify(value),
      }),
    );
  }

  get canCancel() {
    return (
      this.canWrite &&
      this.run &&
      ['awaiting_approval', 'queued', 'running', 'reconciliation_required'].includes(
        this.run.status,
      )
    );
  }
}
