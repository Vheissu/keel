import { z } from 'zod';
import { DomainError } from '../../domain/src/index.js';

export const runbookInputName = z.string().regex(/^[A-Z][A-Z0-9_]{0,47}$/);

const inputText = z
  .string()
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]*$/)
  .refine(
    (value) => new TextDecoder().decode(new TextEncoder().encode(value)) === value,
    'Use valid Unicode text.',
  );

const integer = z.number().int().min(-2147483648).max(2147483647);
const description = z.string().max(200).optional();

const definition = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('string'),
      description,
      minLength: z.number().int().min(0).max(256).default(0),
      maxLength: z.number().int().min(1).max(256),
      default: inputText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('integer'),
      description,
      minimum: integer,
      maximum: integer,
      default: integer.optional(),
    })
    .strict(),
  z.object({ type: z.literal('boolean'), description, default: z.boolean().optional() }).strict(),
  z
    .object({
      type: z.literal('enum'),
      description,
      choices: z
        .array(inputText.min(1))
        .min(1)
        .max(32)
        .refine((values) => new Set(values).size === values.length, 'Choices must be unique.'),
      default: inputText.optional(),
    })
    .strict(),
]);

export type RunbookInput = z.infer<typeof definition>;

export type RunbookInputValues = Record<string, string | number | boolean>;

function accepts(input: RunbookInput, value: unknown): boolean {
  switch (input.type) {
    case 'string':
      return (
        typeof value === 'string' &&
        inputText.safeParse(value).success &&
        value.length >= input.minLength &&
        value.length <= input.maxLength
      );
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= input.minimum &&
        value <= input.maximum
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && input.choices.includes(value);
  }
}

function inputRecord<T extends z.ZodType>(valueSchema: T) {
  return z.preprocess(
    (value, context) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const names = Object.keys(value);

        // Validate raw keys before record parsing, which deliberately skips __proto__.
        if (names.length > 16 || names.some((name) => !runbookInputName.safeParse(name).success)) {
          context.addIssue({
            code: 'custom',
            message: 'Use at most 16 inputs with uppercase names of 1–48 characters.',
          });

          return z.NEVER;
        }
      }

      return value;
    },
    z.record(runbookInputName, valueSchema),
  );
}

export const runbookInputsSchema = inputRecord(
  definition.superRefine((input, ctx) => {
    if (
      (input.type === 'string' && input.minLength > input.maxLength) ||
      (input.type === 'integer' && input.minimum > input.maximum)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'The lower bound must not exceed the upper bound.',
      });
    }

    if (input.default !== undefined && !accepts(input, input.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'The default must satisfy the input bounds.',
      });
    }
  }),
);

export const runbookInputValuesSchema = inputRecord(z.union([inputText, integer, z.boolean()]));

export function resolveRunbookInputs(
  definitions: Record<string, RunbookInput> | undefined,
  source: unknown,
): RunbookInputValues {
  const parsed = runbookInputValuesSchema.safeParse(source);

  if (!parsed.success) {
    throw new DomainError(
      'INVALID_RUNBOOK_INPUTS',
      'Inputs must be an object of at most 16 bounded text, integer or boolean values.',
    );
  }

  const inputs = definitions ?? {};
  const values: RunbookInputValues = {};

  for (const name of Object.keys(parsed.data)) {
    if (!Object.hasOwn(inputs, name)) {
      throw new DomainError(
        'INVALID_RUNBOOK_INPUTS',
        `Input ${name} is not declared by this version.`,
      );
    }
  }

  for (const name of Object.keys(inputs).sort()) {
    const input = inputs[name];
    const value = Object.hasOwn(parsed.data, name) ? parsed.data[name] : input.default;

    if (value === undefined) {
      throw new DomainError('INVALID_RUNBOOK_INPUTS', `Input ${name} is required.`);
    }

    if (!accepts(input, value)) {
      throw new DomainError(
        'INVALID_RUNBOOK_INPUTS',
        `Input ${name} must satisfy its ${input.type} type and declared bounds.`,
      );
    }

    values[name] = value;
  }

  return values;
}
