import type { ChatMessage } from './model.js';

/**
 * The turns of one conversation, in order. A model keeps nothing between
 * requests, so every request carries all of them.
 *
 * A turn is a user message and the reply to it. It is added only when it
 * ends, and only as a whole, so the stored turns always alternate between the
 * user and the assistant, which every provider accepts.
 */
export class Conversation {
  readonly #messages: ChatMessage[] = [];
  #pending: ChatMessage | undefined;

  /** Whether a turn has begun and not yet ended. */
  get busy(): boolean {
    return this.#pending !== undefined;
  }

  /** The turns that have been kept so far. */
  get messages(): readonly ChatMessage[] {
    return this.#messages;
  }

  /**
   * Begins a turn with a message from the user and returns what to send to
   * the model: the kept turns followed by this message.
   */
  begin(text: string): readonly ChatMessage[] {
    if (this.#pending !== undefined) {
      throw new Error('a turn is already in progress');
    }
    this.#pending = { role: 'user', text };
    return [...this.#messages, this.#pending];
  }

  /**
   * Ends the turn. With a reply that contains text, the user message and the
   * reply are kept. Without one, the turn leaves no trace and the user
   * message can be sent again. Does nothing when no turn is in progress.
   */
  end(reply?: string): void {
    const pending = this.#pending;
    if (pending === undefined) {
      return;
    }
    this.#pending = undefined;
    if (reply !== undefined && reply.trim() !== '') {
      this.#messages.push(pending, { role: 'assistant', text: reply });
    }
  }
}
