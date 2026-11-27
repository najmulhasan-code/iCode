import Anthropic from '@anthropic-ai/sdk';
import {
  type ChatMessage,
  type MessagePart,
  type Model,
  ModelError,
  type ModelErrorKind,
  type ModelEvent,
  type ModelRequest,
  type ModelStopReason,
  messageText,
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
  /** Writes a line to the core's log. Never given content from a reply. */
  readonly log?: (text: string) => void;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** Streaming has no response timeout to fit under, so the reply gets room. */
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * Lets the API continue a request on another model when its safety system
 * declines it. The continuation is billed at that model's rate.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The name this adapter puts on the provider blocks it keeps. */
const ADAPTER = 'anthropic';

/**
 * Models that check that the history before each replayed thinking block is
 * unchanged, and that accept the controls for what happens when it is not.
 * Each has thinking on by default, so naming it adaptive changes nothing.
 */
const HISTORY_CHECKED = new Set([
  'claude-fable-5-2',
  'claude-mythos-5-2',
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
]);

/** Lets a request say what happens to a thinking block that fails that check. */
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/** The API's wording when a replayed thinking block no longer matches its conversation. */
const PREFIX_MISMATCH = /bound to a different conversation/i;

/** Creates a model that talks to the Anthropic Messages API. */
export function createAnthropicModel(options: AnthropicModelOptions): Model {
  const client = new Anthropic({
    apiKey: options.apiKey,
    // The SDK's own logging would go to standard output, which carries the protocol.
    logLevel: 'off',
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  // The address the client really uses, including any set by the environment.
  const endpoint = client.baseURL;
  const log = options.log ?? (() => undefined);

  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const messages = toAnthropicMessages(request.messages, endpoint);
      let servedBy: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: Anthropic.Beta.BetaStopReason | null = null;
      /** The model that wrote each block, by its index in the reply. */
      const writer = new Map<number, string>();
      let reply: Anthropic.Beta.BetaMessage | undefined;
      let yielded = false;
      // After the API confirms that a replayed thinking block no longer matches
      // its conversation, the request is sent once more, asking the API to
      // drop the failing blocks. The stored history is never changed.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const recover = attempt === 1;
        try {
          const events = client.beta.messages.stream(
            {
              model,
              max_tokens: maxTokens,
              betas: recover ? [FALLBACK_BETA, BINDING_BETA] : [FALLBACK_BETA],
              fallbacks: 'default',
              ...(recover
                ? {
                    thinking: {
                      type: 'adaptive',
                      block_binding: { prefix_mismatch_behavior: 'drop_block' },
                    },
                  }
                : {}),
              messages,
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
              if (servedBy !== undefined) {
                writer.set(event.index, servedBy);
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                yielded = true;
                yield { type: 'text', text: event.delta.text };
              }
            } else if (event.type === 'message_delta') {
              stopReason = event.delta.stop_reason;
              outputTokens = event.usage.output_tokens;
              inputTokens = event.usage.input_tokens ?? inputTokens;
            }
          }
          if (!request.signal.aborted) {
            reply = await events.finalMessage();
            logDroppedBlocks(reply, log);
          }
          break;
        } catch (error) {
          if (request.signal.aborted) {
            return;
          }
          if (
            !recover &&
            !yielded &&
            HISTORY_CHECKED.has(model) &&
            error instanceof Anthropic.APIError &&
            error.status === 400 &&
            PREFIX_MISMATCH.test(error.message)
          ) {
            log(
              'a replayed thinking block no longer matched its conversation; retrying once with failing blocks dropped',
            );
            continue;
          }
          throw toModelError(error, options.apiKey);
        }
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
        ...(reply === undefined ? {} : { parts: toParts(reply.content, endpoint, writer) }),
      };
    },
  };
}

/**
 * The parts of a reply, in order, each block kept exactly as received with the
 * model that wrote it. A thinking block without its signature was cut off
 * before it was finished, and could never be sent back, so it is not kept.
 */
function toParts(
  blocks: readonly Anthropic.Beta.BetaContentBlock[],
  endpoint: string,
  writer: ReadonlyMap<number, string>,
): MessagePart[] {
  const parts: MessagePart[] = [];
  blocks.forEach((block, index) => {
    if (block.type === 'thinking' && block.signature === '') {
      return;
    }
    const source = { adapter: ADAPTER, endpoint, model: writer.get(index), block };
    parts.push(
      block.type === 'text'
        ? { kind: 'text', text: block.text, source }
        : { kind: 'provider', source },
    );
  });
  return parts;
}

/**
 * The history as the Messages API takes it. A user message is its text. A
 * reply is its kept blocks, unchanged, when they came from this adapter at
 * this address; text from anywhere else goes as plain text, and other
 * providers' blocks are left out.
 */
function toAnthropicMessages(
  messages: readonly ChatMessage[],
  endpoint: string,
): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: messageText(message) };
    }
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const part of message.parts) {
      const source = part.source;
      if (source?.adapter === ADAPTER && source.endpoint === endpoint) {
        blocks.push(source.block as Anthropic.Beta.BetaContentBlockParam);
      } else if (part.kind === 'text') {
        blocks.push({ type: 'text', text: part.text });
      }
    }
    return { role: 'assistant', content: echoAfterFallback(blocks) };
  });
}

/** Block kinds that go back from before a fallback marker. */
const KEPT_BEFORE_FALLBACK = new Set(['text', 'fallback']);

/**
 * Applies the provider's rule for sending back a reply in which another model
 * took over: before the last fallback marker, only text, the markers, and
 * server tool calls with their results go back; thinking, tool calls,
 * connector text, unpaired server tool calls and unknown kinds are left out.
 * The marker stays where it was. Everything after it goes back unchanged.
 * This shapes what is sent each time, the same way, and never the history.
 */
export function echoAfterFallback(
  blocks: readonly Anthropic.Beta.BetaContentBlockParam[],
): Anthropic.Beta.BetaContentBlockParam[] {
  const boundary = blocks.map((block) => block.type).lastIndexOf('fallback');
  if (boundary === -1) {
    return [...blocks];
  }
  const answered = new Set<string>();
  for (const block of blocks.slice(0, boundary)) {
    if (block.type.endsWith('_tool_result') && 'tool_use_id' in block) {
      answered.add(block.tool_use_id);
    }
  }
  const before = blocks.slice(0, boundary).filter((block) => {
    if (KEPT_BEFORE_FALLBACK.has(block.type)) {
      return true;
    }
    if (block.type === 'server_tool_use') {
      return answered.has(block.id);
    }
    return block.type.endsWith('_tool_result') && 'tool_use_id' in block;
  });
  return [...before, ...blocks.slice(boundary)];
}

/** Logs the blocks the API reports it dropped. Only their place and reason, never content. */
function logDroppedBlocks(reply: Anthropic.Beta.BetaMessage, log: (text: string) => void): void {
  const reported: unknown = (reply as { input_transformations?: unknown }).input_transformations;
  if (!Array.isArray(reported)) {
    return;
  }
  for (const entry of reported as { type?: unknown; reason?: unknown; path?: unknown }[]) {
    log(
      `the API changed the history it read: ${String(entry.type)} (${String(entry.reason)}) at ${String(entry.path)}`,
    );
  }
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
