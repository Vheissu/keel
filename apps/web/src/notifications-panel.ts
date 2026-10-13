import { bindable, queueTask } from 'aurelia';
import { Api } from './api';
import { ResourcePage } from './resource-page';
import { errorMessage, formatDate } from './format';

interface Endpoint {
  id: string;
  name: string;
  origin: string;
  enabled: boolean;
  revision: number;
  statuses: string[];
}

interface Delivery {
  id: string;
  endpoint_name: string;
  deployment_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string;
  last_code: string | null;
  last_http_status: number | null;
  delivered_at: string | null;
}

interface Attempt {
  id: string;
  attempt: number;
  code: string;
  http_status: number | null;
  created_at: string;
  completed_at: string | null;
}

export class NotificationsPanel {
  @bindable api!: Api;
  @bindable canWrite = false;
  @bindable projectScoped = false;
  endpoints!: ResourcePage<Endpoint>;
  deliveries!: ResourcePage<Delivery>;
  attempts: ResourcePage<Attempt> | null = null;
  selectedDelivery = '';
  configured = false;
  origins: string[] = [];
  states = [
    'awaiting_approval',
    'queued',
    'running',
    'cancel_requested',
    'reconciliation_required',
    'succeeded',
    'failed',
    'cancelled',
    'rejected',
  ];
  statuses = ['awaiting_approval', 'reconciliation_required', 'succeeded', 'failed'];
  form = false;
  busy = false;
  error = '';
  notice = '';
  name = '';
  url = '';
  secret = '';
  projectId = '';
  environmentId = '';
  nameInput!: HTMLInputElement;
  private active = false;
  private returnFocus: HTMLElement | null = null;

  binding() {
    this.active = true;
    this.endpoints = new ResourcePage(this.api, 'notification-endpoints', 'notification-endpoints');

    this.deliveries = new ResourcePage(
      this.api,
      'notification-deliveries',
      'notification-deliveries',
    );

    void Promise.all([this.endpoints.start(), this.deliveries.start(), this.configuration()]);
  }

  unbinding() {
    this.active = false;
    this.endpoints.dispose();
    this.deliveries.dispose();
    this.attempts?.dispose();
    this.secret = '';
    this.url = '';
  }

  async configuration() {
    try {
      const config = await this.api.request<{ configured: boolean; allowed_origins: string[] }>(
        '/notifications/configuration',
      );

      if (this.active) {
        this.configured = config.configured;
        this.origins = config.allowed_origins;
      }
    } catch (error) {
      if (this.active) {
        this.error = errorMessage(error, 'Could not load notification configuration.');
      }
    }
  }

  async refresh() {
    await Promise.all([
      this.endpoints.load(),
      this.deliveries.load(),
      this.attempts?.load(),
      this.configuration(),
    ]);
  }

  open() {
    this.returnFocus = document.activeElement as HTMLElement;
    this.form = true;
    this.error = '';
    this.notice = '';
    queueTask(() => this.nameInput?.focus());
  }

  close() {
    this.form = false;
    this.secret = '';
    this.url = '';
    this.returnFocus?.focus();
  }

  async mutate(path: string, input: unknown, notice: string) {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';
    this.notice = '';

    try {
      await this.api.request(path, 'POST', input);

      if (this.active) {
        this.notice = notice;
        this.close();
        await this.refresh();
      }
    } catch (error) {
      if (this.active) {
        this.error = errorMessage(error, 'The notification change failed.');
      }
    } finally {
      if (this.active) {
        this.busy = false;
      }
    }
  }

  async save() {
    await this.mutate(
      '/notifications/endpoints',
      {
        name: this.name,
        url: this.url,
        signing_secret: this.secret,
        project_id: this.projectId || null,
        environment_id: this.environmentId || null,
        statuses: this.statuses,
      },
      'Notification destination added.',
    );

    this.secret = '';
  }

  state(endpoint: Endpoint) {
    return this.mutate(
      `/notifications/endpoints/${endpoint.id}/state`,
      { enabled: !endpoint.enabled, expected_revision: endpoint.revision },
      endpoint.enabled
        ? 'Destination disabled. Queued deliveries were cancelled; a send already in progress may finish.'
        : 'Destination enabled for new events.',
    );
  }

  retry(delivery: Delivery) {
    return this.mutate(
      `/notifications/deliveries/${delivery.id}/retry`,
      {},
      'Delivery queued for another attempt.',
    );
  }

  inspect(delivery: Delivery) {
    this.attempts?.dispose();
    this.selectedDelivery = delivery.id;

    this.attempts = new ResourcePage(this.api, 'notification-attempts', '', {
      delivery_id: delivery.id,
    });

    void this.attempts.start();
  }

  date = formatDate;
}
