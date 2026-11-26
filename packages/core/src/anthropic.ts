import Anthropic from '@anthropic-ai/sdk';
import {
  type Model,
  ModelError,
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
        throw toModelError(error);
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

/** Sorts an SDK error into a kind, most specific class first. */
function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) {
    return error;
  }
  // The connection classes extend APIError, so they are checked before it.
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelError('connection', error.message);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ModelError('authentication', error.message, error.status);
  }
  if (
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.PaymentRequiredError
  ) {
    return new ModelError('permission', error.message, error.status);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ModelError('not_found', error.message, error.status);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ModelError('rate_limit', error.message, error.status);
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ModelError('overloaded', error.message, error.status);
  }
  if (error instanceof Anthropic.APIError) {
    const rawStatus: unknown = error.status;
    const status = typeof rawStatus === 'number' ? rawStatus : undefined;
    // An error event inside an open stream has no HTTP status of its own.
    if (error.type === 'overloaded_error' || error.type === 'api_error') {
      return new ModelError('overloaded', error.message, status);
    }
    if (error.type === 'rate_limit_error') {
      return new ModelError('rate_limit', error.message, status);
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return new ModelError('invalid_request', error.message, status);
    }
    return new ModelError('unexpected', error.message, status);
  }
  return new ModelError('unexpected', error instanceof Error ? error.message : String(error));
}
