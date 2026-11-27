import type { StopReason } from '@icode/protocol';
import { ConversationLostError, type ConversationRef } from './chatSession';

/** How one message sent from the panel ended. */
export type ChatOutcome =
  { readonly text: string; readonly stopReason: StopReason } | { readonly error: string };

/** What a test learns about one submission: how it ended and what the page showed for it. */
export type SubmitResult = ChatOutcome & { readonly shown?: string };

/**
 * One thing a chat shows, in order. A reply without a stop reason is the part
 * of a reply that was written before the request failed.
 */
export type ChatEntry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'reply'; readonly text: string; readonly stopReason?: StopReason }
  | { readonly kind: 'error'; readonly text: string };

/**
 * A message from the extension to the page. Every reply message names the
 * request it belongs to.
 */
export type PanelMessage =
  | { readonly type: 'text'; readonly id: number; readonly text: string }
  | { readonly type: 'end'; readonly id: number; readonly stopReason: StopReason }
  /**
   * With `withdraw`, the message was not sent: it was refused, or the chat
   * can no longer be continued. Its text goes back into the composer.
   */
  | {
      readonly type: 'error';
      readonly id: number;
      readonly message: string;
      readonly withdraw?: true;
    }
  | { readonly type: 'submit'; readonly text: string; readonly token: number }
  /**
   * Show this chat. The page answers with `switched`, naming `seq` and the
   * unsent text of the chat it showed until now. With `carry`, the page keeps
   * the text in its composer for this chat, instead of `draft`.
   */
  | {
      readonly type: 'show';
      readonly seq: number;
      readonly key: number;
      readonly entries: readonly ChatEntry[];
      readonly draft: string;
      readonly carry: boolean;
    }
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
  resume(conversation: ConversationRef | undefined): Promise<void>;
}

/** A chat as the chat list shows it. */
export interface ChatSummary {
  readonly key: number;
  /** The first message, or the unsent text when nothing was sent. */
  readonly text: string;
  /** When it was last used, in milliseconds since 1970. */
  readonly lastUsed: number;
  readonly current: boolean;
  /** Nothing was sent in it: it holds only unsent text. */
  readonly notSent: boolean;
  /** iCode's engine has lost its history, so it can be read but not continued. */
  readonly lost: boolean;
}

/** What starting a new chat did. `empty`: the shown chat was empty, so nothing changed. */
export type NewChatResult = 'started' | 'empty' | 'closed';

/** What opening a chat from the list did. */
export type OpenResult = 'opened' | 'current' | 'gone' | 'closed';

/** Everything the extension keeps about one chat. */
interface ChatRecord {
  readonly key: number;
  readonly entries: ChatEntry[];
  draft: string;
  /** The core's conversation, while the chat is not the current one. */
  conversation: ConversationRef | undefined;
  lastUsed: number;
  lost: boolean;
}

/** A `show` message that the page has not confirmed yet. */
interface PendingShow {
  readonly seq: number;
  readonly record: ChatRecord;
  readonly carry: boolean;
  readonly resolve: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text taken back from a request goes before what the composer already holds. */
function joinDraft(text: string, draft: string): string {
  return draft === '' ? text : `${text}\n${draft}`;
}

/**
 * The logic behind the chat panel, without the editor: it accepts requests
 * from the page, runs them one at a time, and sends each piece and each
 * outcome back to the page that asked.
 *
 * It keeps every chat of this window: what each one shows, its unsent text,
 * and its conversation in the core. The page only draws the chat it is told
 * to show, so a page that closes loses nothing, and the next page shows the
 * same chat again. A chat that is opened again is only shown: nothing in it
 * runs again.
 *
 * Switches run one after another, and each waits until the page confirms it.
 * The confirmation carries the final unsent text of the chat the page left.
 * Messages from one page arrive in the order it sent them, so nothing older
 * about that chat can arrive later. Each message the page sends names the
 * chat it was sent in, and one that names any other chat is refused.
 *
 * The page is not trusted. Only a well-formed request is acted on, and all a
 * page can ask for is to send a message, to stop the reply, and to keep the
 * unsent text of the chat it shows.
 */
export class ChatPanelController {
  readonly #chat: ChatBackend;
  readonly #now: () => number;
  #port: PanelPort | undefined;
  #active: { readonly port: PanelPort; readonly id: number } | undefined;
  /** Settles when the running request has ended and been recorded. */
  #activeDone: Promise<void> = Promise.resolve();
  readonly #outcomes = new Map<number, ChatOutcome>();
  readonly #tokenByRequest = new Map<number, number>();
  readonly #waiting = new Map<number, (result: SubmitResult) => void>();
  #nextToken = 1;

  readonly #records = new Map<number, ChatRecord>();
  #nextKey = 1;
  /** The chat the core's current conversation belongs to. */
  #current: ChatRecord;
  /** The chat the open page has confirmed it shows. */
  #pageKey: number | undefined;
  #pending: PendingShow | undefined;
  #nextSeq = 1;
  /** Switches run one after another. While one runs, no message is sent. */
  #switches: Promise<unknown> = Promise.resolve();
  #switching = 0;

  constructor(chat: ChatBackend, now: () => number = Date.now) {
    this.#chat = chat;
    this.#now = now;
    this.#current = this.#create();
  }

  /**
   * A page has opened. A reply still being written for an earlier page is
   * stopped, and the page is shown the current chat once that reply has
   * ended and been recorded.
   */
  attach(port: PanelPort): void {
    this.detach();
    this.#port = port;
    void this.#serialize(async () => {
      await this.#activeDone;
      if (this.#port === port) {
        await this.#show(port, this.#current, false);
      }
    }).catch(() => undefined);
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
    this.#pageKey = undefined;
    // A switch waiting for this page goes on without it.
    this.#pending?.resolve();
    this.#pending = undefined;
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
    } else if (message.type === 'draft') {
      this.#handleDraft(message);
    } else if (message.type === 'switched') {
      this.#handleSwitched(message);
    } else if (message.type === 'shown') {
      this.#handleShown(message);
    } else if (message.type === 'rejected' && typeof message.token === 'number') {
      this.#settle(message.token, { error: 'The chat panel did not accept the message.' });
    }
  }

  /**
   * Starts a new chat. A reply being written is stopped first, and the new
   * chat begins once it has ended. The previous chat stays in the list. When
   * the previous chat can no longer be continued, its unsent text moves to
   * the new chat.
   */
  newChat(): Promise<NewChatResult> {
    return this.#serialize(async (): Promise<NewChatResult> => {
      const port = this.#port;
      if (port === undefined) {
        return 'closed';
      }
      if (this.#current.entries.length === 0) {
        port.post({ type: 'focus' });
        return 'empty';
      }
      await this.#stopActive();
      const previous = this.#current;
      previous.conversation = await this.#chat.setAside();
      this.#current = this.#create();
      if (this.#port !== port) {
        return 'closed';
      }
      await this.#show(port, this.#current, previous.lost);
      return 'started';
    });
  }

  /** Opens a chat from the list. A reply being written is stopped first. */
  open(key: number): Promise<OpenResult> {
    return this.#serialize(async (): Promise<OpenResult> => {
      const port = this.#port;
      if (port === undefined) {
        return 'closed';
      }
      const target = this.#records.get(key);
      if (target === undefined) {
        return 'gone';
      }
      if (target === this.#current) {
        port.post({ type: 'focus' });
        return 'current';
      }
      await this.#stopActive();
      const previous = this.#current;
      previous.conversation = await this.#chat.setAside();
      try {
        await this.#chat.resume(target.conversation);
      } catch (error) {
        // The core's conversation and the shown chat must stay together.
        await this.#chat.resume(previous.conversation);
        previous.conversation = undefined;
        throw error;
      }
      target.conversation = undefined;
      target.lastUsed = this.#now();
      this.#current = target;
      if (this.#port !== port) {
        return 'closed';
      }
      await this.#show(port, target, false);
      return 'opened';
    });
  }

  /** The chats of this window that hold anything, the most recently used first. */
  chats(): ChatSummary[] {
    return (
      [...this.#records.values()]
        .filter((record) => record.entries.length > 0 || record.draft.trim() !== '')
        // Of two chats used at the same moment, the one begun later comes first.
        .sort((a, b) => b.lastUsed - a.lastUsed || b.key - a.key)
        .map((record) => {
          const first = record.entries.find((entry) => entry.kind === 'user');
          return {
            key: record.key,
            text: first?.text ?? record.draft,
            lastUsed: record.lastUsed,
            current: record === this.#current,
            notSent: record.entries.length === 0,
            lost: record.lost,
          };
        })
    );
  }

  /**
   * Submits a message as if it had been typed into the panel. Resolves when
   * the page reports what it showed for it. Used by the end-to-end tests.
   */
  async submit(text: string): Promise<SubmitResult> {
    // A page that has just opened is first shown its chat.
    await this.#switches;
    const port = this.#port;
    if (port === undefined) {
      return { error: 'The chat panel is not open.' };
    }
    if (text.trim() === '') {
      return { error: 'The message is empty.' };
    }
    const token = this.#nextToken;
    this.#nextToken += 1;
    return new Promise((resolve) => {
      this.#waiting.set(token, resolve);
      port.post({ type: 'submit', text, token });
    });
  }

  #create(): ChatRecord {
    const record: ChatRecord = {
      key: this.#nextKey,
      entries: [],
      draft: '',
      conversation: undefined,
      lastUsed: this.#now(),
      lost: false,
    };
    this.#nextKey += 1;
    this.#records.set(record.key, record);
    return record;
  }

  /** Tells the page to show a chat, and resolves once it has, or has closed. */
  #show(port: PanelPort, record: ChatRecord, carry: boolean): Promise<void> {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    return new Promise((resolve) => {
      this.#pending = { seq, record, carry, resolve };
      port.post({
        type: 'show',
        seq,
        key: record.key,
        entries: [...record.entries],
        draft: record.draft,
        carry,
      });
    });
  }

  /** The page confirms a switch, with the final unsent text of the chat it left. */
  #handleSwitched(message: Record<string, unknown>): void {
    const pending = this.#pending;
    if (pending === undefined || message.seq !== pending.seq) {
      return;
    }
    this.#pending = undefined;
    const { left } = message;
    const leftRecord = this.#pageKey === undefined ? undefined : this.#records.get(this.#pageKey);
    if (
      leftRecord !== undefined &&
      isRecord(left) &&
      left.key === leftRecord.key &&
      typeof left.draft === 'string'
    ) {
      if (pending.carry) {
        leftRecord.draft = '';
        pending.record.draft = left.draft;
      } else {
        leftRecord.draft = left.draft;
      }
      // A chat left with nothing in it is not kept.
      if (
        leftRecord !== this.#current &&
        leftRecord.entries.length === 0 &&
        leftRecord.draft === ''
      ) {
        this.#records.delete(leftRecord.key);
      }
    }
    this.#pageKey = pending.record.key;
    pending.resolve();
  }

  /** The page reports the unsent text of the chat it shows. */
  #handleDraft(message: Record<string, unknown>): void {
    const { chat, text } = message;
    if (typeof chat === 'number' && chat === this.#pageKey && typeof text === 'string') {
      const record = this.#records.get(chat);
      if (record !== undefined) {
        record.draft = text;
      }
    }
  }

  /** Runs one switch after the ones before it. */
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

  /** Stops the running request, if any, and waits until it has been recorded. */
  async #stopActive(): Promise<void> {
    if (this.#active !== undefined) {
      this.#chat.cancel();
    }
    await this.#activeDone;
  }

  #handleSend(port: PanelPort, message: Record<string, unknown>): void {
    const { id, text, token, chat } = message;
    if (typeof id !== 'number' || typeof text !== 'string') {
      return;
    }
    if (typeof token === 'number') {
      this.#tokenByRequest.set(id, token);
    }
    // Every request gets an answer, so the page can never wait forever. A
    // refused message was not sent, so the page puts it back into the composer.
    const refuse = (reason: string): void => {
      this.#outcomes.set(id, { error: reason });
      port.post({ type: 'error', id, message: reason, withdraw: true });
    };
    const trimmed = text.trim();
    if (trimmed === '') {
      refuse('The message is empty.');
    } else if (this.#active !== undefined) {
      refuse('A reply is still being written. Wait for it or stop it first.');
    } else if (this.#switching > 0) {
      refuse('The chat is being switched. Send the message again in a moment.');
    } else if (chat !== this.#current.key || chat !== this.#pageKey) {
      refuse('The chat was switched before this message arrived. Send it again.');
    } else if (this.#current.lost) {
      refuse(new ConversationLostError().message);
    } else {
      const record = this.#current;
      record.entries.push({ kind: 'user', text: trimmed });
      record.lastUsed = this.#now();
      this.#activeDone = this.#run(port, id, trimmed, record);
    }
  }

  /** Runs one request and records it in the chat it was sent in, whatever happens to the page. */
  async #run(port: PanelPort, id: number, text: string, record: ChatRecord): Promise<void> {
    this.#active = { port, id };
    // Pieces and the outcome go only to the page that asked, while it is still open.
    const post = (message: PanelMessage): void => {
      if (this.#port === port) {
        port.post(message);
      }
    };
    let reply = '';
    let outcome: ChatOutcome;
    let lost = false;
    try {
      const stopReason = await this.#chat.send(text, (piece) => {
        reply += piece;
        post({ type: 'text', id, text: piece });
      });
      outcome = { text: reply, stopReason };
      record.entries.push({ kind: 'reply', text: reply, stopReason });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed.';
      outcome = { error: message };
      if (error instanceof ConversationLostError) {
        // Nothing was sent. The message leaves the chat and goes back to the composer.
        lost = true;
        record.lost = true;
        record.entries.pop();
        record.entries.push({ kind: 'error', text: message });
        if (this.#port !== port) {
          record.draft = joinDraft(text, record.draft);
        }
      } else {
        if (reply !== '') {
          record.entries.push({ kind: 'reply', text: reply });
        }
        record.entries.push({ kind: 'error', text: message });
      }
    }
    this.#active = undefined;
    record.lastUsed = this.#now();
    if (this.#port !== port) {
      return;
    }
    this.#outcomes.set(id, outcome);
    if ('error' in outcome) {
      post(
        lost
          ? { type: 'error', id, message: outcome.error, withdraw: true }
          : { type: 'error', id, message: outcome.error },
      );
    } else {
      post({ type: 'end', id, stopReason: outcome.stopReason });
    }
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
