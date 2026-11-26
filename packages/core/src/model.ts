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

/** Why a model stopped writing. */
export type ModelStopReason = 'end' | 'max_tokens';

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
  | { readonly type: 'end'; readonly reason: ModelStopReason; readonly usage?: ModelUsage };

/**
 * A language model, as the rest of the core sees it. Each provider is reached
 * through an adapter that implements this interface.
 */
export interface Model {
  /** Streams the reply to a conversation. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
