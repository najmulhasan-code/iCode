import type { StopReason } from '@icode/protocol';

/** How one message sent from the panel ended. */
export type ChatOutcome =
  { readonly text: string; readonly stopReason: StopReason } | { readonly error: string };

/** What a test learns about one submission: how it ended and what the page showed for it. */
export type SubmitResult = ChatOutcome & { readonly shown?: string };

/** A message from the extension to the page. Every reply message names the request it belongs to. */
export type PanelMessage =
  | { readonly type: 'text'; readonly id: number; readonly text: string }
  | { readonly type: 'end'; readonly id: number; readonly stopReason: StopReason }
  | { readonly type: 'error'; readonly id: number; readonly message: string }
  | { readonly type: 'submit'; readonly text: string; readonly token: number };

/** One open page of the chat panel. */
export interface PanelPort {
  post(message: PanelMessage): void;
}

/** The part of a chat session the panel uses. */
export interface ChatBackend {
  send(text: string, onText: (text: string) => void): Promise<StopReason>;
  cancel(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The logic behind the chat panel, without the editor: it accepts requests
 * from the page, runs them one at a time, and sends each piece and each
 * outcome back to the page that asked.
 *
 * The page is not trusted. Only a well-formed request is acted on, and all a
 * page can ask for is to send a message or to stop the reply.
 */
export class ChatPanelController {
  readonly #chat: ChatBackend;
  #port: PanelPort | undefined;
  #active: { readonly port: PanelPort; readonly id: number } | undefined;
  readonly #outcomes = new Map<number, ChatOutcome>();
  readonly #tokenByRequest = new Map<number, number>();
  readonly #waiting = new Map<number, (result: SubmitResult) => void>();
  #nextToken = 1;

  constructor(chat: ChatBackend) {
    this.#chat = chat;
  }

  /** A page has opened. A reply still being written for an earlier page is stopped. */
  attach(port: PanelPort): void {
    this.detach();
    this.#port = port;
  }

  /** The page is gone. Its reply is stopped, and nothing more is sent to it. */
  detach(port?: PanelPort): void {
    if (port !== undefined && port !== this.#port) {
      return;
    }
    if (this.#active !== undefined) {
      this.#chat.cancel();
    }
    this.#port = undefined;
    this.#outcomes.clear();
    this.#tokenByRequest.clear();
    for (const resolve of this.#waiting.values()) {
      resolve({ error: 'The chat panel was closed.' });
    }
    this.#waiting.clear();
  }

  /** Handles a message that a page sent. */
  handle(port: PanelPort, message: unknown): void {
    if (port !== this.#port || !isRecord(message)) {
      return;
    }
    if (message.type === 'cancel') {
      if (this.#active?.port === port) {
        this.#chat.cancel();
      }
    } else if (message.type === 'send') {
      this.#handleSend(port, message);
    } else if (message.type === 'shown') {
      this.#handleShown(message);
    } else if (message.type === 'rejected' && typeof message.token === 'number') {
      this.#settle(message.token, { error: 'The chat panel did not accept the message.' });
    }
  }

  /**
   * Submits a message as if it had been typed into the panel. Resolves when
   * the page reports what it showed for it. Used by the end-to-end tests.
   */
  submit(text: string): Promise<SubmitResult> {
    const port = this.#port;
    if (port === undefined) {
      return Promise.resolve({ error: 'The chat panel is not open.' });
    }
    if (text.trim() === '') {
      return Promise.resolve({ error: 'The message is empty.' });
    }
    const token = this.#nextToken;
    this.#nextToken += 1;
    return new Promise((resolve) => {
      this.#waiting.set(token, resolve);
      port.post({ type: 'submit', text, token });
    });
  }

  #handleSend(port: PanelPort, message: Record<string, unknown>): void {
    const { id, text, token } = message;
    if (typeof id !== 'number' || typeof text !== 'string') {
      return;
    }
    if (typeof token === 'number') {
      this.#tokenByRequest.set(id, token);
    }
    // Every request gets an answer, so the page can never wait forever.
    const refuse = (reason: string): void => {
      this.#outcomes.set(id, { error: reason });
      port.post({ type: 'error', id, message: reason });
    };
    const trimmed = text.trim();
    if (trimmed === '') {
      refuse('The message is empty.');
    } else if (this.#active !== undefined) {
      refuse('A reply is still being written. Wait for it or stop it first.');
    } else {
      void this.#run(port, id, trimmed);
    }
  }

  async #run(port: PanelPort, id: number, text: string): Promise<void> {
    this.#active = { port, id };
    // Pieces and the outcome go only to the page that asked, while it is still open.
    const post = (message: PanelMessage): void => {
      if (this.#port === port) {
        port.post(message);
      }
    };
    let reply = '';
    let outcome: ChatOutcome;
    try {
      const stopReason = await this.#chat.send(text, (piece) => {
        reply += piece;
        post({ type: 'text', id, text: piece });
      });
      outcome = { text: reply, stopReason };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : 'The request failed.' };
    }
    this.#active = undefined;
    if (this.#port !== port) {
      return;
    }
    this.#outcomes.set(id, outcome);
    post(
      'error' in outcome
        ? { type: 'error', id, message: outcome.error }
        : { type: 'end', id, stopReason: outcome.stopReason },
    );
  }

  /** The page reports what it displayed once a request had ended. */
  #handleShown(message: Record<string, unknown>): void {
    const { id, text } = message;
    if (typeof id !== 'number') {
      return;
    }
    const outcome = this.#outcomes.get(id);
    const token = this.#tokenByRequest.get(id);
    this.#outcomes.delete(id);
    this.#tokenByRequest.delete(id);
    if (outcome !== undefined && token !== undefined) {
      this.#settle(token, { ...outcome, ...(typeof text === 'string' ? { shown: text } : {}) });
    }
  }

  #settle(token: number, result: SubmitResult): void {
    const resolve = this.#waiting.get(token);
    this.#waiting.delete(token);
    resolve?.(result);
  }
}
