import { type ChatMessage, type MessagePart, messageText, textMessage } from './model.js';

/** One turn in progress: a message from the user that is waiting for its reply. */
export interface Turn {
  /** What to send to the model: the kept turns followed by this message. */
  readonly messages: readonly ChatMessage[];
  /**
   * Ends this turn. With a reply whose parts contain text, the user message
   * and the reply are kept. Without one, the turn leaves no trace and the
   * user message can be sent again. Only the first call has an effect, and
   * it never touches a turn that began later. Returns whether the turn was kept.
   */
  end(reply?: readonly MessagePart[]): boolean;
}

/**
 * The turns of one conversation, in order. A model keeps nothing between
 * requests, so every request carries all of them.
 *
 * A turn is a user message and the reply to it. It is added only when it
 * ends, and only as a whole, so the stored turns always alternate between the
 * user and the assistant, which every provider accepts.
 *
 * The history is append-only: a kept message is never changed or removed.
 * Providers bind a reply's signed thinking to everything before it, so an
 * earlier change would make later thinking invalid.
 */
export class Conversation {
  readonly #messages: ChatMessage[] = [];
  #current: Turn | undefined;
  /** Notes that model adapters keep about this conversation. */
  readonly memory = new Map<string, string>();

  /** Whether a turn has begun and not yet ended. */
  get busy(): boolean {
    return this.#current !== undefined;
  }

  /** The turns that have been kept so far. */
  get messages(): readonly ChatMessage[] {
    return this.#messages;
  }

  /** Begins a turn with a message from the user. */
  begin(text: string): Turn {
    if (this.#current !== undefined) {
      throw new Error('a turn is already in progress');
    }
    const user = textMessage('user', text);
    const turn: Turn = {
      messages: [...this.#messages, user],
      end: (reply) => {
        // A turn that has ended is no longer the current one, so a late or
        // repeated call cannot end the turn that followed it.
        if (this.#current !== turn) {
          return false;
        }
        this.#current = undefined;
        if (reply === undefined) {
          return false;
        }
        const assistant: ChatMessage = { role: 'assistant', parts: [...reply] };
        if (messageText(assistant).trim() === '') {
          return false;
        }
        this.#messages.push(user, assistant);
        return true;
      },
    };
    this.#current = turn;
    return turn;
  }
}
