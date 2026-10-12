import { DomainError } from '../../domain/src/index.js';

export class ProviderError extends DomainError {
  constructor(
    code: string,
    message: string,
    public retryable = false,
    public retryAfterSeconds = 0,
  ) {
    super(code, message, retryable ? 503 : 422);
  }
}

export async function boundedResponse(
  response: Response,
  maximumBytes: number,
  provider = 'Provider',
): Promise<Buffer> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (!reader) {
    throw new ProviderError('PROVIDER_RESPONSE_INVALID', `${provider} returned an empty response.`);
  }

  try {
    if (Number(response.headers.get('content-length')) > maximumBytes) {
      throw new ProviderError(
        'PROVIDER_SIZE_LIMIT',
        `The ${provider} response exceeds the configured size limit.`,
      );
    }

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      size += chunk.value.length;

      if (size > maximumBytes) {
        throw new ProviderError(
          'PROVIDER_SIZE_LIMIT',
          `The ${provider} response exceeds the configured size limit.`,
        );
      }

      chunks.push(chunk.value);
    }

    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }

    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      `The ${provider} response was interrupted. The import will retry.`,
      true,
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Converts rate-limit headers into a bounded retry delay, defaulting to one minute.
export function rateLimitDelay(headers: Headers) {
  const retryAfter = Number(headers.get('retry-after') ?? NaN);
  const reset = Number(headers.get('x-ratelimit-reset') ?? NaN) - Date.now() / 1000;
  let seconds = 60;

  if (retryAfter > 0) {
    seconds = retryAfter;
  } else if (reset > 0) {
    seconds = reset;
  }

  return Math.min(3600, Math.max(30, Math.ceil(seconds)));
}
