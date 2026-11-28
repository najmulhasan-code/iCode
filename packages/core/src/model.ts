/**
 * A piece of content that belongs to one provider: a block of its reply kept
 * exactly as received, with where it came from. It goes back only to the same
 * adapter at the same address, and never to a client or a log.
 */
export interface ProviderBlock {
  /** The adapter that received it, such as `anthropic`. */
  readonly adapter: string;
  /** The API address the adapter's client actually used. */
  readonly endpoint: string;
  /** The model that wrote this block, when the provider said. */
  readonly model?: string | undefined;
  /** The block itself, unchanged. */
  readonly block: unknown;
}

/**
 * A part of a message, in order. Text keeps its original provider block when
 * it has one, so that metadata such as citations goes back unchanged; its
 * `text` is what clients and other providers see. Any other provider block,
 * such as a signed thinking block, is kept whole and is opaque to the rest of
 * the core.
 */
export type MessagePart =
  | { readonly kind: 'text'; readonly text: string; readonly source?: ProviderBlock | undefined }
  | { readonly kind: 'provider'; readonly source: ProviderBlock };

/** One message of a conversation: a role and its parts, in order. */
export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly parts: readonly MessagePart[];
}

/** A message of plain text. */
export function textMessage(role: ChatMessage['role'], text: string): ChatMessage {
  return { role, parts: [{ kind: 'text', text }] };
}

/** The text of a message: its text parts, joined. */
export function messageText(message: ChatMessage): string {
  return message.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  /** Aborted when the reply is no longer wanted. */
  readonly signal: AbortSignal;
  /**
   * Notes an adapter keeps about this conversation, such as a recovery it
   * must continue on later requests. They live with the conversation, so
   * they outlast the adapter and never affect another conversation.
   */
  readonly memory?: Map<string, string>;
}

/**
 * Why a model stopped writing: it finished, it reached its output limit, or
 * the provider's safety system declined the request.
 */
export type ModelStopReason = 'end' | 'max_tokens' | 'refusal';

/** Tokens a request consumed, when the provider reports them. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Something a model produces while it replies. A reply is any number of
 * `text` events followed by exactly one `end` event.
 */
export type ModelEvent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'end';
      readonly reason: ModelStopReason;
      readonly usage?: ModelUsage;
      /** The model that wrote the reply, when the provider names it. */
      readonly model?: string;
      /**
       * The whole reply as ordered parts, for the conversation to keep. An
       * adapter that leaves it out has its reply kept as the text it streamed.
       */
      readonly parts?: readonly MessagePart[];
    };

/**
 * A language model, as the rest of the core sees it. Each provider is reached
 * through an adapter that implements this interface.
 */
export interface Model {
  /** Streams the reply to a conversation. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** What went wrong with a model request, in terms a client can act on. */
export type ModelErrorKind =
  | 'authentication'
  | 'permission'
  | 'not_found'
  | 'invalid_request'
  | 'rate_limit'
  | 'overloaded'
  | 'connection'
  | 'unexpected';

/**
 * Thrown while building a model when the settings do not fit the provider.
 * Its message is written by this code base and is safe to show to a client.
 */
export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

/** Thrown by a model adapter when a request fails. */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  /** HTTP status of the provider's answer, when there was one. */
  readonly status: number | undefined;

  constructor(kind: ModelErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
  }
}
