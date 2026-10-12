import { z } from 'zod';
import {
  bitbucketRepository,
  bitbucketUuid,
} from '../../../packages/integrations/src/bitbucket-pipelines.js';

export const bitbucketCredentialsInput = z
  .object({
    token: z.string().trim().min(16).max(1024),
    publish_secret: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  })
  .strict();

export const bitbucketConnectionInput = bitbucketCredentialsInput
  .extend({
    name: z.string().trim().min(1).max(100),
    project_id: z.string().uuid(),
    repository: bitbucketRepository,
    workflow_id: z
      .string()
      .regex(/^(default:|branches:.+|custom:.+)$/)
      .max(255),
    branch: z.string().trim().min(1).max(255),
    artifact_name: z.string().trim().min(1).max(100),
  })
  .strict();

export const bitbucketPublishInput = z
  .object({
    run_id: bitbucketUuid,
    step_id: bitbucketUuid,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
