import { bindable } from 'aurelia';

const paths: Record<string, string> = {
  Overview: 'm3 10 9-7 9 7v11h-6v-7H9v7H3V10Z',
  Projects: 'M3 6h6l2 2h10v12H3V6Z',
  Artifacts: 'm12 3 9 5v9l-9 5-9-5V8l9-5Zm0 9 9-4M12 12 3 8m9 4v10',
  Releases: 'M3 4h9l9 9-8 8-10-10V4Zm5 4h.01',
  Deployments: 'm7 4 14 8-14 8V4Z',
  Environments: 'M4 4h16v5H4V4Zm0 11h16v5H4v-5Zm4-8h.01M8 18h.01',
  Secrets: 'M6 10h12v11H6V10Zm2 0V6a4 4 0 0 1 8 0v4m-4 5v2',
  Targets: 'M3 4h18v12H3V4Zm4 16h10M12 16v4M6 8h.01M6 12h.01',
  Integrations:
    'M9 7 7 5a4 4 0 0 0-6 6l4 4a4 4 0 0 0 6 0m4-6 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0M8 16l8-8',
  'Audit log': 'M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7M9 16h7',
};

export class NavIcon {
  @bindable name = 'Overview';

  get path() {
    return paths[this.name];
  }
}
