import Anthropic from '@anthropic-ai/sdk';
import {
  type Model,
  ModelError,
  type ModelErrorKind,
  type ModelEvent,
  type ModelRequest,
  type ModelStopReason,
} from './model.js';
import { kindForStatus, redact } from './modelErrors.js';

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
      // A cancelled stream can also end without an error.
      if (request.signal.aborted) {
        return;
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
    default:
      // No tools or context management are requested, so these cannot be a
      // normal end of a reply. A value this code does not know is treated the
      // same way.
      // The reason is the server's text and is left out of the message.
      throw new ModelError('unexpected', 'the reply ended with an unexpected stop reason');
  }
}

/** Error types the API names in a response body or in an error event of a stream. */
const KIND_BY_ERROR_TYPE: ReadonlyMap<string, ModelErrorKind> = new Map([
  ['authentication_error', 'authentication'],
  ['permission_error', 'permission'],
  ['billing_error', 'permission'],
  ['not_found_error', 'not_found'],
  ['invalid_request_error', 'invalid_request'],
  ['request_too_large', 'invalid_request'],
  ['rate_limit_error', 'rate_limit'],
  ['overloaded_error', 'overloaded'],
  ['api_error', 'overloaded'],
  ['timeout_error', 'connection'],
]);

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
    const named = typeof rawType === 'string' ? KIND_BY_ERROR_TYPE.get(rawType) : undefined;
    const kind = named ?? (status === undefined ? 'unexpected' : kindForStatus(status));
    return new ModelError(kind, message, status);
  }
  return new ModelError('unexpected', message);
}
