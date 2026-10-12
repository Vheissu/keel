export type Provider =
  'github-actions' | 'bitbucket-pipelines' | 'azure-pipelines' | 'gitlab-ci' | 'jenkins';

export interface ProviderCapabilities {
  listPipelines: boolean;
  getRun: boolean;
  listArtifacts: boolean;
  triggerRun: boolean;
  cancelRun: boolean;
  deployment: boolean;
  rollback: boolean;
}

export interface ProviderConnection {
  id: string;
  organisationId: string;
  provider: Provider;
  credentialReference: string;
  repository: string;
}

export interface ExternalPipeline {
  id: string;
  name: string;
  url: string;
}

export interface ExternalRun {
  id: string;
  pipelineId: string;
  commit: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  originalStatus: string;
  url: string;
}

export interface ExternalArtifact {
  id: string;
  name: string;
  size: number;
  expiresAt: string | null;
}

export interface CIProviderAdapter {
  capabilities(): ProviderCapabilities;
  listPipelines(connection: ProviderConnection): Promise<ExternalPipeline[]>;
  getRun(connection: ProviderConnection, runId: string): Promise<ExternalRun>;
  listArtifacts(connection: ProviderConnection, runId: string): Promise<ExternalArtifact[]>;
  triggerRun?(
    connection: ProviderConnection,
    pipelineId: string,
    ref: string,
  ): Promise<ExternalRun>;
  cancelRun?(connection: ProviderConnection, runId: string): Promise<void>;
}

export const githubCapabilities: ProviderCapabilities = {
  listPipelines: true,
  getRun: true,
  listArtifacts: true,
  triggerRun: false,
  cancelRun: false,
  deployment: false,
  rollback: false,
};

const unavailableCapabilities: ProviderCapabilities = {
  listPipelines: false,
  getRun: false,
  listArtifacts: false,
  triggerRun: false,
  cancelRun: false,
  deployment: false,
  rollback: false,
};

// Availability describes implemented adapters, not configured connections.
const providerNames: { id: Provider; name: string; available: boolean }[] = [
  { id: 'github-actions', name: 'GitHub Actions', available: true },
  { id: 'bitbucket-pipelines', name: 'Bitbucket Pipelines', available: false },
  { id: 'azure-pipelines', name: 'Azure Pipelines', available: false },
  { id: 'gitlab-ci', name: 'GitLab CI/CD', available: false },
  { id: 'jenkins', name: 'Jenkins', available: false },
];

export const providers = providerNames.map((provider) => ({
  ...provider,
  capabilities: provider.available ? githubCapabilities : unavailableCapabilities,
}));
