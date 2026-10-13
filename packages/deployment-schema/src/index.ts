import { z } from 'zod';
import { parseDocument } from 'yaml';
import { DomainError } from '../../domain/src/index.js';
import { runbookInputsSchema } from './runbook-inputs.js';

export * from './runbook-inputs.js';

export const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const maxSecretReferences = 32;

export const maxSecretValueBytes = 8192;

export const lifecycleHook = z
  .object({
    command: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^\x00-\x1f\x7f]*$/),
      )
      .min(1)
      .max(32),
    timeoutSeconds: z.number().int().min(1).max(120),
    secrets: z
      .array(secretName)
      .max(maxSecretReferences)
      .refine((names) => new Set(names).size === names.length)
      .optional(),
    network: z.enum(['none', 'target']).optional(),
  })
  .strict();

const environment = z
  .object({
    strategy: z.enum(['recreate', 'rolling', 'blue-green']),
    targetSelector: z.object({ labels: z.record(z.string().min(1), z.string().min(1)) }).strict(),
    requiresApproval: z.boolean().optional(),
    hooks: z
      .object({ preDeploy: lifecycleHook.optional(), postDeploy: lifecycleHook.optional() })
      .strict()
      .refine((hooks) => !!hooks.preDeploy || !!hooks.postDeploy, 'Declare at least one hook.')
      .optional(),
    secrets: z
      .record(secretName, z.object({ secret: secretName }).strict())
      .refine(
        (value) => Object.keys(value).length <= maxSecretReferences,
        `Use at most ${maxSecretReferences} secret references.`,
      )
      .optional(),
    verify: z
      .object({
        http: z
          .object({
            path: z
              .string()
              .startsWith('/')
              .max(200)
              .refine(
                (value) => !value.startsWith('//') && !/[\x00-\x20#]/.test(value),
                'Use a relative HTTP path without whitespace or a fragment.',
              ),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [phase, hook] of Object.entries(config.hooks ?? {})) {
      for (const name of hook.secrets ?? []) {
        if (!Object.hasOwn(config.secrets ?? {}, name)) {
          context.addIssue({
            code: 'custom',
            path: ['hooks', phase, 'secrets'],
            message: `Hook secret ${name} must reference an environment secret variable.`,
          });
        }
      }
    }
  });

export const processSchema = z
  .object({
    apiVersion: z.literal('keel.dev/v1alpha1'),
    kind: z.literal('DeploymentProcess'),
    metadata: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }).strict(),
    spec: z
      .object({
        artifact: z
          .object({
            source: z.literal('release'),
            name: z.string().min(1).max(100),
            dockerArchivePath: z
              .string()
              .max(200)
              .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*(\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*$/)
              .optional(),
            dockerImageId: z
              .string()
              .regex(/^sha256:[a-f0-9]{64}$/)
              .optional(),
          })
          .strict(),
        environments: z
          .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), environment)
          .refine((v) => Object.keys(v).length > 0, 'At least one environment is required.'),
      })
      .strict(),
  })
  .strict();

export type DeploymentProcess = z.infer<typeof processSchema>;

function parseSource(source: unknown): unknown {
  let value = source;

  if (typeof source === 'string') {
    if (source.length > 64000) {
      throw new DomainError('INVALID_PROCESS', 'Deployment process exceeds 64 KB.');
    }

    try {
      const document = parseDocument(source, { uniqueKeys: true });

      if (document.errors.length) {
        throw document.errors[0];
      }

      value = document.toJS({ maxAliasCount: 0 });
    } catch {
      throw new DomainError(
        'INVALID_PROCESS',
        'Invalid YAML. Duplicate keys and aliases are not supported.',
      );
    }
  }

  return value;
}

export function parseProcess(source: unknown): DeploymentProcess {
  const result = processSchema.safeParse(parseSource(source));

  if (!result.success) {
    throw new DomainError(
      'INVALID_PROCESS',
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  return result.data;
}

export type EnvironmentProcess = DeploymentProcess['spec']['environments'][string];

export function requiresApproval(
  environment: { requires_approval: boolean },
  config: EnvironmentProcess,
) {
  return environment.requires_approval || !!config.requiresApproval;
}

// Executable Docker processes require a pinned image and HTTP verification.
export function supportsDockerDeployment(
  process: DeploymentProcess,
  config: EnvironmentProcess | undefined,
): config is EnvironmentProcess & { verify: NonNullable<EnvironmentProcess['verify']> } {
  return (
    !!config &&
    ['recreate', 'blue-green'].includes(config.strategy) &&
    !!config.verify &&
    !!process.spec.artifact.dockerImageId &&
    Object.keys(config.targetSelector.labels).length > 0
  );
}

// Capabilities are strategy-specific: registering a target never opts it into another strategy.
export function supportsTargetStrategy(
  capability: string,
  strategy: EnvironmentProcess['strategy'],
) {
  return strategy === 'blue-green'
    ? capability === 'docker-blue-green-v1'
    : strategy === 'recreate' &&
        ['docker-recreate-v1', 'ssh-docker-recreate-v1'].includes(capability);
}

export const runbookSchema = z
  .object({
    apiVersion: z.literal('keel.dev/v1alpha1'),
    kind: z.literal('Runbook'),
    spec: z
      .object({
        artifact: processSchema.shape.spec.shape.artifact
          .pick({ dockerImageId: true, dockerArchivePath: true })
          .required({ dockerImageId: true }),
        task: lifecycleHook.omit({ secrets: true }),
        inputs: runbookInputsSchema.optional(),
        secrets: z
          .record(secretName, z.object({ secret: secretName }).strict())
          .refine((value) => Object.keys(value).length <= maxSecretReferences)
          .optional(),
        requiresApproval: z.boolean().default(true),
      })
      .strict()
      .superRefine((spec, context) => {
        for (const name of Object.keys(spec.inputs ?? {})) {
          if (Object.hasOwn(spec.secrets ?? {}, `KEEL_INPUT_${name}`)) {
            context.addIssue({
              code: 'custom',
              path: ['inputs', name],
              message: 'The input environment variable conflicts with a secret binding.',
            });
          }
        }
      }),
  })
  .strict();

export type RunbookProcess = z.infer<typeof runbookSchema>;

export function parseRunbook(source: unknown): RunbookProcess {
  const result = runbookSchema.safeParse(parseSource(source));

  if (!result.success) {
    throw new DomainError(
      'INVALID_RUNBOOK',
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }

  return result.data;
}
