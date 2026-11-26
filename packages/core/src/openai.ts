import OpenAI from 'openai';
import {
  type Model,
  ModelError,
  type ModelErrorKind,
  type ModelEvent,
  type ModelRequest,
  type ModelStopReason,
  type ModelUsage,
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
}

/**
 * Creates a model that talks to any server with an OpenAI-compatible Chat
 * Completions API: OpenAI itself, other hosted providers, or a local server.
 */
export function createOpenAICompatibleModel(options: OpenAICompatibleModelOptions): Model {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });

  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      let servedBy: string | undefined;
      let usage: ModelUsage | undefined;
      let finishReason: string | undefined;
      try {
        const chunks = await client.chat.completions.create(
          {
            model: options.model,
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.text,
            })),
            stream: true,
            // Without this the token counts are left out of a streamed reply.
            stream_options: { include_usage: true },
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
            usage = {
              inputTokens: loose.usage.prompt_tokens ?? 0,
              outputTokens: loose.usage.completion_tokens ?? 0,
            };
          }
          const choice = loose.choices?.[0];
          if (!choice) {
            continue;
          }
          const text = choice.delta?.content;
          if (typeof text === 'string' && text !== '') {
            yield { type: 'text', text };
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
        reason: toStopReason(finishReason),
        ...(usage === undefined ? {} : { usage }),
        ...(servedBy === undefined ? {} : { model: servedBy }),
      };
    },
  };
}

/** A stream chunk as a compatible server may really send it. */
interface LooseChunk {
  readonly model?: unknown;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number } | null;
  readonly choices?: readonly (
    | {
        readonly delta?: { readonly content?: unknown } | null;
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
      throw new ModelError(
        'unexpected',
        `the reply ended with the unexpected finish reason ${reason}`,
      );
  }
}

/** Error codes that say more than the HTTP status they arrive with. */
const KIND_BY_ERROR_CODE: Readonly<Record<string, ModelErrorKind>> = {
  // Sent with status 429, and waiting does not help: the account has no credit.
  insufficient_quota: 'permission',
  invalid_api_key: 'authentication',
  model_not_found: 'not_found',
  rate_limit_exceeded: 'rate_limit',
  server_error: 'overloaded',
};

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
      KIND_BY_ERROR_CODE[error.code ?? ''] ?? KIND_BY_ERROR_CODE[error.type ?? ''] ?? undefined;
    const kind = named ?? (status === undefined ? 'unexpected' : kindForStatus(status));
    return new ModelError(kind, message, status);
  }
  return new ModelError('unexpected', message);
}
