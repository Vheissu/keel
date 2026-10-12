import { z } from 'zod';
import { parseDocument } from 'yaml';
import { DomainError } from '../../domain/src/index.js';

const environment = z
  .object({
    strategy: z.enum(['recreate', 'rolling']),
    targetSelector: z.object({ labels: z.record(z.string().min(1), z.string().min(1)) }).strict(),
    requiresApproval: z.boolean().optional(),
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
  .strict();

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

export function parseProcess(source: unknown): DeploymentProcess {
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

  const result = processSchema.safeParse(value);

  if (!result.success) {
    throw new DomainError(
      'INVALID_PROCESS',
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  return result.data;
}
