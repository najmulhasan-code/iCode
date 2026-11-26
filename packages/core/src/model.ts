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

/** Something a model produces while it replies. */
export interface ModelEvent {
  readonly type: 'text';
  readonly text: string;
}

/**
 * A language model, as the rest of the core sees it. Each provider is reached
 * through an adapter that implements this interface.
 */
export interface Model {
  /** Streams the reply to a conversation. The stream ends when the reply does. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
