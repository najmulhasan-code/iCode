import Anthropic from '@anthropic-ai/sdk';
import {
  type Model,
  ModelError,
  type ModelErrorKind,
  type ModelEvent,
  type ModelRequest,
  type ModelStopReason,
} from './model.js';

export interface AnthropicModelOptions {
  readonly apiKey: string;
  /** Model id. Defaults to `DEFAULT_ANTHROPIC_MODEL`. */
  readonly model?: string;
  /** Upper limit on the tokens of one reply. */
  readonly maxTokens?: number;
  /** Address of the API, for a proxy or a test server. */
  readonly baseURL?: string;
  /** How often a failed request is retried. The SDK's default is two. */
  readonly maxRetries?: number;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** Streaming has no response timeout to fit under, so the reply gets room. */
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * Lets the API continue a request on another model when its safety system
 * declines it. The continuation is billed at that model's rate.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Creates a model that talks to the Anthropic Messages API. */
export function createAnthropicModel(options: AnthropicModelOptions): Model {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      let servedBy: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: Anthropic.Beta.BetaStopReason | null = null;
      try {
        const events = client.beta.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.text,
            })),
          },
          { signal: request.signal },
        );
        for await (const event of events) {
          if (event.type === 'message_start') {
            servedBy = event.message.model;
            inputTokens = event.message.usage.input_tokens;
          } else if (event.type === 'content_block_start') {
            // The API switched to another model after a decline. From here on
            // that model writes the reply. There can be several switches.
            if (event.content_block.type === 'fallback') {
              servedBy = event.content_block.to.model;
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text };
            }
          } else if (event.type === 'message_delta') {
            stopReason = event.delta.stop_reason;
            outputTokens = event.usage.output_tokens;
            inputTokens = event.usage.input_tokens ?? inputTokens;
          }
        }
      } catch (error) {
        if (request.signal.aborted) {
          return;
        }
        throw toModelError(error, options.apiKey);
      }
      yield {
        type: 'end',
        reason: toStopReason(stopReason),
        usage: { inputTokens, outputTokens },
        ...(servedBy === undefined ? {} : { model: servedBy }),
      };
    },
  };
}

function toStopReason(reason: Anthropic.Beta.BetaStopReason | null): ModelStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'tool_use':
    case 'pause_turn':
    case 'compaction':
    case null:
      // No tools or context management are requested, so these cannot be a
      // normal end of a reply.
      throw new ModelError(
        'unexpected',
        `the reply ended with the unexpected stop reason ${String(reason)}`,
      );
  }
}

/** Error types the API names in a response body or in an error event of a stream. */
const KIND_BY_ERROR_TYPE: Readonly<Record<string, ModelErrorKind>> = {
  authentication_error: 'authentication',
  permission_error: 'permission',
  billing_error: 'permission',
  not_found_error: 'not_found',
  invalid_request_error: 'invalid_request',
  request_too_large: 'invalid_request',
  rate_limit_error: 'rate_limit',
  overloaded_error: 'overloaded',
  api_error: 'overloaded',
  timeout_error: 'connection',
};

function kindForStatus(status: number): ModelErrorKind {
  if (status === 401) {
    return 'authentication';
  }
  if (status === 402 || status === 403) {
    return 'permission';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 408) {
    return 'connection';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  // A conflict is transient on this API, like a server-side failure.
  if (status === 409 || status >= 500) {
    return 'overloaded';
  }
  if (status >= 400) {
    return 'invalid_request';
  }
  return 'unexpected';
}

/**
 * Removes credentials from text that came from outside. A provider may echo
 * part of a request in an error message, and that text is written to the log.
 */
function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey === '' ? text : text.split(apiKey).join('[redacted]');
  return withoutKey
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
}

/**
 * Turns a failure into a ModelError. The kind comes from the error type the
 * API named when there is one, because an error inside an open stream has no
 * HTTP status, and from the status otherwise.
 */
function toModelError(error: unknown, apiKey: string): ModelError {
  if (error instanceof ModelError) {
    return error;
  }
  const message = redact(error instanceof Error ? error.message : String(error), apiKey);
  // The connection classes extend APIError, so they are checked before it.
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelError('connection', message);
  }
  if (error instanceof Anthropic.APIError) {
    const rawStatus: unknown = error.status;
    const status = typeof rawStatus === 'number' ? rawStatus : undefined;
    const rawType: unknown = error.type;
    const named = typeof rawType === 'string' ? KIND_BY_ERROR_TYPE[rawType] : undefined;
    const kind = named ?? (status === undefined ? 'unexpected' : kindForStatus(status));
    return new ModelError(kind, message, status);
  }
  return new ModelError('unexpected', message);
}
