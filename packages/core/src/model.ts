/** One turn of a conversation. */
export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  /** Aborted when the reply is no longer wanted. */
  readonly signal: AbortSignal;
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
