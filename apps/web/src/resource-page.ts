import type { Api } from './api';
import { errorMessage } from './format';

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  next_cursor: string | null;
  previous_cursor: string | null;
}

export class ResourcePage<T> {
  items: T[] = [];
  total = 0;
  limit = 25;
  query = '';
  cursor = '';
  nextCursor: string | null = null;
  previousCursor: string | null = null;
  loading = false;
  error = '';
  private revision = 0;
  private requestedQuery = '';
  private active = true;
  private hashChange = () => {
    void this.readLocation();
  };

  constructor(
    public api: Api,
    public resource: string,
    public key = '',
    public filters: Record<string, string> = {},
  ) {}

  async start() {
    if (this.key) {
      window.addEventListener('hashchange', this.hashChange);
    }

    await this.readLocation();
  }

  dispose() {
    this.active = false;
    this.revision++;
    window.removeEventListener('hashchange', this.hashChange);
  }

  private async readLocation() {
    if (this.key) {
      const params = new URLSearchParams(window.location.hash.split('?')[1] || '');

      this.query = params.get(`${this.key}.q`) || '';
      this.cursor = params.get(`${this.key}.cursor`) || '';
      this.limit = Number(params.get(`${this.key}.limit`) || 25);
    }

    await this.load();
  }

  async search() {
    // A pending debounce must not reset navigation after a size change already applied the search.
    if (this.query !== this.requestedQuery) {
      await this.navigate();
    }
  }

  async navigate(cursor = '') {
    if (!this.active) {
      return;
    }

    this.cursor = cursor;

    if (this.key) {
      const [path, search] = window.location.hash.split('?');
      const params = new URLSearchParams(search || '');

      for (const [name, value] of Object.entries({
        q: this.query,
        cursor,
        limit: String(this.limit),
      })) {
        if (value) {
          params.set(`${this.key}.${name}`, value);
        } else {
          params.delete(`${this.key}.${name}`);
        }
      }

      window.history.pushState(null, '', `${path || '#overview'}?${params}`);
    }

    await this.load();
  }

  async load() {
    if (!this.active) {
      return;
    }

    const revision = ++this.revision;

    this.requestedQuery = this.query;
    this.loading = true;
    this.error = '';

    try {
      const params = new URLSearchParams({
        ...this.filters,
        limit: String(this.limit),
        q: this.query,
      });

      if (this.cursor) {
        params.set('cursor', this.cursor);
      }

      const result = await this.api.request<PageResult<T>>(`/resources/${this.resource}?${params}`);

      if (this.active && revision === this.revision) {
        this.items = result.items;
        this.total = result.total;
        this.nextCursor = result.next_cursor;
        this.previousCursor = result.previous_cursor;
      }
    } catch (error) {
      if (this.active && revision === this.revision) {
        this.items = [];
        this.total = 0;
        this.nextCursor = null;
        this.previousCursor = null;
        this.error = errorMessage(error, 'Could not load this page.');
      }
    } finally {
      if (this.active && revision === this.revision) {
        this.loading = false;
      }
    }
  }
}
