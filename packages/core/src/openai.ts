import OpenAI from 'openai';
import {
  type Model,
  ModelError,
  type ModelErrorKind,
  type ModelEvent,
  type ModelRequest,
  type ModelStopReason,
  type ModelUsage,
  checkedUsage,
  messageText,
} from './model.js';
import { kindForStatus, redact } from './modelErrors.js';

export interface OpenAICompatibleModelOptions {
  readonly apiKey: string;
  /** Model id, as the server names it. Providers share no common names, so there is no default. */
  readonly model: string;
  /** Address of the server. Defaults to the OpenAI API. */
  readonly baseURL?: string;
  /** How often a failed request is retried. The SDK's default is two. */
  readonly maxRetries?: number;
  /**
   * Whether to ask the server for token counts in the stream. On by default.
   * Turn it off for a server that rejects the `stream_options` field.
   */
  readonly reportUsage?: boolean;
}

/**
 * Creates a model that talks to any server with an OpenAI-compatible Chat
 * Completions API: OpenAI itself, other hosted providers, or a local server.
 */
export function createOpenAICompatibleModel(options: OpenAICompatibleModelOptions): Model {
  const client = new OpenAI({
    apiKey: options.apiKey,
    // The SDK's own logging would go to standard output, which carries the protocol.
    logLevel: 'off',
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });

  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      let servedBy: string | undefined;
      let usage: ModelUsage | undefined;
      let finishReason: string | undefined;
      let refused = false;
      try {
        const chunks = await client.chat.completions.create(
          {
            model: options.model,
            // This API takes text only; provider blocks from another adapter are left out.
            messages: request.messages.map((message) => ({
              role: message.role,
              content: messageText(message),
            })),
            stream: true,
            // Without this the token counts are left out of a streamed reply.
            ...(options.reportUsage === false ? {} : { stream_options: { include_usage: true } }),
          },
          { signal: request.signal },
        );
        for await (const chunk of chunks) {
          // Servers differ in what they leave out, so every field is read defensively.
          const loose = chunk as LooseChunk;
          if (typeof loose.model === 'string' && loose.model !== '') {
            servedBy = loose.model;
          }
          if (loose.usage) {
            // This API counts cached input inside the prompt tokens already.
            // A count the server left out stays unknown; it is never set to zero.
            const details = loose.usage.prompt_tokens_details;
            usage = checkedUsage({
              inputTokens: loose.usage.prompt_tokens,
              outputTokens: loose.usage.completion_tokens,
              cacheReadTokens: details?.cached_tokens,
              cacheWriteTokens: details?.cache_write_tokens,
            });
          }
          const choice = loose.choices?.[0];
          if (!choice) {
            continue;
          }
          const text = choice.delta?.content;
          if (typeof text === 'string' && text !== '') {
            yield { type: 'text', text };
          }
          // A refusal is written to its own field. It is shown like any other text.
          const refusal = choice.delta?.refusal;
          if (typeof refusal === 'string' && refusal !== '') {
            refused = true;
            yield { type: 'text', text: refusal };
          }
          if (typeof choice.finish_reason === 'string') {
            finishReason = choice.finish_reason;
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
        reason: refused ? 'refusal' : toStopReason(finishReason),
        ...(usage === undefined ? {} : { usage }),
        ...(servedBy === undefined ? {} : { model: servedBy }),
      };
    },
  };
}

/** A stream chunk as a compatible server may really send it. */
interface LooseChunk {
  readonly model?: unknown;
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly prompt_tokens_details?: {
      readonly cached_tokens?: unknown;
      readonly cache_write_tokens?: unknown;
    } | null;
  } | null;
  readonly choices?: readonly (
    | {
        readonly delta?: { readonly content?: unknown; readonly refusal?: unknown } | null;
        readonly finish_reason?: unknown;
      }
    | undefined
  )[];
}

function toStopReason(reason: string | undefined): ModelStopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case undefined:
      // A reply that was cut off must not be shown as complete.
      throw new ModelError('unexpected', 'the reply ended without a finish reason');
    default:
      // No tools are offered, so a tool call cannot be a normal end of a reply.
      // The reason is the server's text and is left out of the message.
      throw new ModelError('unexpected', 'the reply ended with an unexpected finish reason');
  }
}

/** Error codes that say more than the HTTP status they arrive with. */
const KIND_BY_ERROR_CODE: ReadonlyMap<string, ModelErrorKind> = new Map([
  // Sent with status 429, and waiting does not help: the account has no credit.
  ['insufficient_quota', 'permission'],
  ['invalid_api_key', 'authentication'],
  ['context_length_exceeded', 'context_overflow'],
  ['model_not_found', 'not_found'],
  ['rate_limit_exceeded', 'rate_limit'],
  ['server_error', 'overloaded'],
]);

function toModelError(error: unknown, apiKey: string): ModelError {
  if (error instanceof ModelError) {
    return error;
  }
  const message = redact(error instanceof Error ? error.message : String(error), apiKey);
  // The connection classes extend APIError, so they are checked before it.
  if (error instanceof OpenAI.APIConnectionError) {
    return new ModelError('connection', message);
  }
  if (error instanceof OpenAI.APIError) {
    const rawStatus: unknown = error.status;
    const status = typeof rawStatus === 'number' ? rawStatus : undefined;
    const named =
      KIND_BY_ERROR_CODE.get(error.code ?? '') ?? KIND_BY_ERROR_CODE.get(error.type ?? '');
    const kind = named ?? (status === undefined ? 'unexpected' : kindForStatus(status));
    return new ModelError(kind, message, status);
  }
  return new ModelError('unexpected', message);
}
