import type { StopReason } from '@icode/protocol';
import type { ConversationRef } from './chatSession';

/** How one message sent from the panel ended. */
export type ChatOutcome =
  { readonly text: string; readonly stopReason: StopReason } | { readonly error: string };

/** What a test learns about one submission: how it ended and what the page showed for it. */
export type SubmitResult = ChatOutcome & { readonly shown?: string };

/**
 * A message from the extension to the page. Every reply message names the
 * request it belongs to. A conversation the page puts aside is named by a key
 * that the extension chose.
 */
export type PanelMessage =
  | { readonly type: 'text'; readonly id: number; readonly text: string }
  | { readonly type: 'end'; readonly id: number; readonly stopReason: StopReason }
  | { readonly type: 'error'; readonly id: number; readonly message: string }
  | { readonly type: 'submit'; readonly text: string; readonly token: number }
  /** Put the shown conversation aside under `stashKey` and show an empty one. */
  | { readonly type: 'newChat'; readonly stashKey: number }
  /**
   * Show the conversation put aside under `key`. With `stashKey`, the shown
   * conversation is put aside under it first. Without, the shown
   * conversation is empty and is dropped.
   */
  | { readonly type: 'openChat'; readonly key: number; readonly stashKey?: number }
  /** Move the cursor to the composer. */
  | { readonly type: 'focus' };

/** One open page of the chat panel. */
export interface PanelPort {
  post(message: PanelMessage): void;
}

/** The part of a chat session the panel uses. */
export interface ChatBackend {
  send(text: string, onText: (text: string) => void): Promise<StopReason>;
  cancel(): void;
  setAside(): Promise<ConversationRef | undefined>;
  resume(conversation: ConversationRef | undefined): Promise<boolean>;
}

/** What starting a new chat did. */
export type NewChatResult =
  /** The shown conversation was empty, so nothing changed. */
  | { readonly kind: 'empty' }
  /** A new conversation was begun. The previous one can be reopened with this key. */
  | { readonly kind: 'started'; readonly previous: number }
  /** No page is open. */
  | { readonly kind: 'closed' };

/** What reopening a chat did. */
export type ReopenResult = 'reopened' | 'none' | 'gone' | 'closed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The logic behind the chat panel, without the editor: it accepts requests
 * from the page, runs them one at a time, and sends each piece and each
 * outcome back to the page that asked.
 *
 * It also starts new chats and reopens earlier ones. The page keeps what each
 * conversation shows, and the core keeps what each conversation says. Both are
 * switched together, so what the model is sent always matches what the page
 * shows. A reopened conversation is only shown again: nothing in it runs again.
 *
 * The page is not trusted. Only a well-formed request is acted on, and all a
 * page can ask for is to send a message or to stop the reply.
 */
export class ChatPanelController {
  readonly #chat: ChatBackend;
  #port: PanelPort | undefined;
  #active: { readonly port: PanelPort; readonly id: number } | undefined;
  /** Settles when the running request has ended and its outcome was posted. */
  #activeDone: Promise<void> = Promise.resolve();
  readonly #outcomes = new Map<number, ChatOutcome>();
  readonly #tokenByRequest = new Map<number, number>();
  readonly #waiting = new Map<number, (result: SubmitResult) => void>();
  #nextToken = 1;

  /** The key of the shown conversation, and whether anything was sent in it. */
  #current = { key: 1, used: false };
  #nextKey = 2;
  /** Conversations put aside on the open page, by key, oldest first. */
  readonly #aside = new Map<number, ConversationRef | undefined>();
  /** Switches run one after another. While one runs, no message is sent. */
  #switches: Promise<unknown> = Promise.resolve();
  #switching = 0;
  /** A page that showed a conversation has closed, so the core's conversation no longer matches. */
  #stale = false;

  constructor(chat: ChatBackend) {
    this.#chat = chat;
  }

  /**
   * A page has opened. A reply still being written for an earlier page is
   * stopped. A new page shows an empty conversation, so when an earlier page
   * had shown one, the core begins a new conversation as well.
   */
  attach(port: PanelPort): void {
    this.detach();
    this.#port = port;
    if (this.#stale) {
      this.#stale = false;
      void this.#serialize(async () => {
        await this.#chat.setAside();
      }).catch(() => undefined);
    }
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
    // What a closed page showed is gone, so its conversations cannot be reopened.
    if (this.#current.used) {
      this.#stale = true;
    }
    this.#aside.clear();
    this.#current = { key: this.#takeKey(), used: false };
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
   * Starts a new chat. A reply being written is stopped first, and the new
   * chat begins once it has ended. The previous conversation is kept, and the
   * result names it so that it can be reopened.
   */
  newChat(): Promise<NewChatResult> {
    return this.#serialize(async (): Promise<NewChatResult> => {
      const port = this.#port;
      if (port === undefined) {
        return { kind: 'closed' };
      }
      if (!this.#current.used) {
        port.post({ type: 'focus' });
        return { kind: 'empty' };
      }
      await this.#stopActive();
      const conversation = await this.#chat.setAside();
      if (this.#port !== port) {
        return { kind: 'closed' };
      }
      const previous = this.#current.key;
      this.#aside.set(previous, conversation);
      this.#current = { key: this.#takeKey(), used: false };
      port.post({ type: 'newChat', stashKey: previous });
      return { kind: 'started', previous };
    });
  }

  /**
   * Reopens a conversation that was put aside: the one with this key, or the
   * one put aside last. The shown conversation is put aside in its place,
   * unless nothing was sent in it.
   */
  reopen(key?: number): Promise<ReopenResult> {
    return this.#serialize(async (): Promise<ReopenResult> => {
      const port = this.#port;
      if (port === undefined) {
        return 'closed';
      }
      const target = key ?? [...this.#aside.keys()].at(-1);
      if (target === undefined) {
        return 'none';
      }
      if (!this.#aside.has(target)) {
        return 'gone';
      }
      await this.#stopActive();
      const shown = await this.#chat.setAside();
      const resumed = await this.#chat.resume(this.#aside.get(target));
      if (!resumed) {
        // The core that held it has stopped. The shown conversation stays.
        this.#aside.delete(target);
        await this.#chat.resume(shown);
        return 'gone';
      }
      if (this.#port !== port) {
        return 'closed';
      }
      this.#aside.delete(target);
      if (this.#current.used) {
        this.#aside.set(this.#current.key, shown);
        port.post({ type: 'openChat', key: target, stashKey: this.#current.key });
      } else {
        port.post({ type: 'openChat', key: target });
      }
      this.#current = { key: target, used: true };
      return 'reopened';
    });
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

  #takeKey(): number {
    const key = this.#nextKey;
    this.#nextKey += 1;
    return key;
  }

  /** Runs one switch of conversation after the ones before it. */
  #serialize<T>(task: () => Promise<T>): Promise<T> {
    this.#switching += 1;
    const run = async (): Promise<T> => {
      try {
        return await task();
      } finally {
        // Cleared before the caller learns the result, so a message sent
        // right after a switch is accepted.
        this.#switching -= 1;
      }
    };
    const result = this.#switches.then(run);
    this.#switches = result.catch(() => undefined);
    return result;
  }

  /** Stops the running request, if any, and waits until its outcome has been posted. */
  async #stopActive(): Promise<void> {
    if (this.#active !== undefined) {
      this.#chat.cancel();
    }
    await this.#activeDone;
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
    } else if (this.#switching > 0) {
      refuse('The chat is being switched. Send the message again in a moment.');
    } else {
      this.#current.used = true;
      this.#activeDone = this.#run(port, id, trimmed);
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
