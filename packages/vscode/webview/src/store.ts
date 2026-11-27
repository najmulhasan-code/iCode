import type { StopReason } from '@icode/protocol';
import type { ChatEntry, ChatListItem, PanelMessage } from '../../src/panelProtocol';

/** Words shown under a reply that ended for a reason other than finishing. */
export const NOTE_BY_STOP_REASON: Partial<Record<StopReason, string>> = {
  cancelled: 'Stopped.',
  max_tokens: 'The reply reached the length limit.',
  refusal: 'The model declined this request.',
};

/** The message being answered: its number, its text, the reply so far, and the test token it came with. */
export interface Pending {
  readonly id: number;
  readonly text: string;
  readonly reply: string;
  readonly token?: number | undefined;
}

/** The chat list, while it is shown in place of the chat. */
export interface HistoryState {
  readonly items: readonly ChatListItem[];
  readonly query: string;
  /** The rows that match the query, in order. */
  readonly matching: readonly ChatListItem[];
  /** The highlighted row among `matching`, or -1. */
  readonly highlighted: number;
}

export interface ChatState {
  /** The key of the chat shown, as the extension last said. Null until then. */
  readonly chatKey: number | null;
  readonly entries: readonly ChatEntry[];
  readonly pending: Pending | null;
  /** The text in the composer. */
  readonly draft: string;
  readonly history: HistoryState | null;
  /** Grows each time the composer should take the cursor. */
  readonly focusComposer: number;
}

/** A message from the page to the extension. The bridge adds the page's load number. */
export type PageMessage = Record<string, unknown> & { readonly type: string };

const INITIAL: ChatState = {
  chatKey: null,
  entries: [],
  pending: null,
  draft: '',
  history: null,
  focusComposer: 0,
};

/** Text taken back from a request goes before what the composer already holds. */
function joinDraft(text: string, draft: string): string {
  return draft === '' ? text : `${text}\n${draft}`;
}

function filterItems(items: readonly ChatListItem[], query: string): readonly ChatListItem[] {
  const wanted = query.trim().toLowerCase();
  return items.filter((item) => item.title.toLowerCase().includes(wanted));
}

/**
 * The logic of the chat page, without any drawing: it receives the
 * extension's messages, keeps what the page shows, and sends the page's
 * messages. The React view only draws its state and calls its actions.
 *
 * The extension keeps every chat. The page shows the one it is told to show
 * and reports the unsent text of that chat as it changes. Every message sent
 * names the chat it was typed in. Each switch is confirmed with the final
 * unsent text of the chat the page leaves, and with the numbers of the
 * messages that text now holds because they were taken back.
 */
export class ChatStore {
  #state: ChatState = INITIAL;
  readonly #post: (message: PageMessage) => void;
  readonly #listeners = new Set<() => void>();
  #nextId = 1;
  /** Numbers of messages put back into the composer since the last report. */
  #returned: number[] = [];

  constructor(post: (message: PageMessage) => void) {
    this.#post = post;
  }

  getState = (): ChatState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #set(change: Partial<ChatState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /** Handles a message from the extension. Anything malformed is ignored. */
  receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const data = message as PanelMessage;
    switch (data.type) {
      case 'show':
        this.#show(data);
        return;
      case 'history':
        this.#openHistory(data.items);
        return;
      case 'focus':
        if (this.#state.history === null) {
          this.#set({ focusComposer: this.#state.focusComposer + 1 });
        } else {
          this.closeHistory();
        }
        return;
      case 'submit':
        if (!this.#submit(data.text, data.token, false)) {
          this.#post({ type: 'rejected', token: data.token });
        }
        return;
      case 'text':
      case 'end':
      case 'error':
        this.#answer(data);
        return;
    }
  }

  // ---------------------------------------------------------------- the chat

  /** The person changed the text in the composer. */
  setDraft(text: string): void {
    this.#set({ draft: text });
    this.#reportDraft();
  }

  /** The person pressed Send. Returns false when nothing could be sent. */
  send(): boolean {
    return this.#submit(this.#state.draft, undefined, true);
  }

  /** The person pressed Stop. */
  stop(): void {
    this.#post({ type: 'cancel' });
  }

  /** Copies text through the extension, which owns the clipboard. */
  copy(text: string): void {
    this.#post({ type: 'copy', text });
  }

  /** Asks the extension to open a link. The extension checks it again. */
  openLink(url: string): void {
    this.#post({ type: 'openLink', url });
  }

  #reportDraft(): void {
    if (this.#state.chatKey !== null) {
      this.#post({
        type: 'draft',
        chat: this.#state.chatKey,
        text: this.#state.draft,
        returned: this.#returned,
      });
      this.#returned = [];
    }
  }

  #submit(text: string, token: number | undefined, fromComposer: boolean): boolean {
    const trimmed = text.trim();
    const { pending, chatKey } = this.#state;
    if (pending !== null || chatKey === null || trimmed === '') {
      return false;
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const draft = fromComposer ? '' : this.#state.draft;
    this.#set({ pending: { id, text: trimmed, reply: '', token }, draft });
    // A message typed into the composer empties it, and the send says so.
    this.#post({ type: 'send', id, chat: chatKey, text: trimmed, draft, token });
    return true;
  }

  #answer(data: Extract<PanelMessage, { type: 'text' | 'end' | 'error' }>): void {
    const { pending } = this.#state;
    if (pending?.id !== data.id) {
      return;
    }
    if (data.type === 'text') {
      this.#set({ pending: { ...pending, reply: pending.reply + data.text } });
      return;
    }
    if (data.type === 'end') {
      const entries: ChatEntry[] = [
        ...this.#state.entries,
        { kind: 'user', text: pending.text },
        { kind: 'reply', text: pending.reply, stopReason: data.stopReason },
      ];
      this.#set({ pending: null, entries, focusComposer: this.#state.focusComposer + 1 });
      this.#post({ type: 'shown', id: data.id, text: pending.reply });
      return;
    }
    if (data.withdraw === true) {
      // The message was not sent. It goes back into the composer, and the reason is shown.
      this.#returned.push(pending.id);
      this.#set({
        pending: null,
        draft: joinDraft(pending.text, this.#state.draft),
        entries: [...this.#state.entries, { kind: 'error', text: data.message }],
        focusComposer: this.#state.focusComposer + 1,
      });
      this.#reportDraft();
      this.#post({ type: 'shown', id: data.id, text: data.message });
      return;
    }
    const entries: ChatEntry[] = [...this.#state.entries, { kind: 'user', text: pending.text }];
    if (pending.reply !== '') {
      entries.push({ kind: 'reply', text: pending.reply });
    }
    entries.push({ kind: 'error', text: data.message });
    this.#set({ pending: null, entries, focusComposer: this.#state.focusComposer + 1 });
    this.#post({ type: 'shown', id: data.id, text: data.message });
  }

  /**
   * The extension switches only once its last reply has ended, so a request
   * still waiting here was sent after the switch began and will be refused.
   * Its message is taken back into the composer, so nothing typed is lost.
   */
  #withdrawPending(): void {
    const { pending } = this.#state;
    if (pending === null) {
      return;
    }
    this.#returned.push(pending.id);
    this.#set({ pending: null, draft: joinDraft(pending.text, this.#state.draft) });
    if (pending.token !== undefined) {
      this.#post({ type: 'rejected', token: pending.token });
    }
  }

  #show(data: Extract<PanelMessage, { type: 'show' }>): void {
    // A switch always ends on the chat itself.
    this.#set({ history: null });
    this.#withdrawPending();
    const { chatKey, draft } = this.#state;
    // The final unsent text of the chat this page leaves.
    const left = chatKey === null ? null : { key: chatKey, draft, returned: this.#returned };
    this.#returned = [];
    this.#post({ type: 'switched', seq: data.seq, left });
    this.#set({
      chatKey: data.key,
      entries: data.entries,
      draft: data.carry ? draft : data.draft,
      focusComposer: this.#state.focusComposer + 1,
    });
  }

  // ----------------------------------------------------------- the chat list

  #openHistory(items: readonly ChatListItem[]): void {
    this.#set({
      history: { items, query: '', matching: items, highlighted: items.length > 0 ? 0 : -1 },
    });
  }

  /** The person typed in the search box of the chat list. */
  setQuery(query: string): void {
    const { history } = this.#state;
    if (history === null) {
      return;
    }
    const matching = filterItems(history.items, query);
    this.#set({
      history: { ...history, query, matching, highlighted: matching.length > 0 ? 0 : -1 },
    });
  }

  /** Moves the highlight by one row, wrapping around. */
  moveHighlight(step: 1 | -1): void {
    const { history } = this.#state;
    if (history === null || history.matching.length === 0) {
      return;
    }
    const count = history.matching.length;
    this.#set({
      history: { ...history, highlighted: (history.highlighted + step + count) % count },
    });
  }

  /** Opens the highlighted chat. */
  pickHighlighted(): void {
    const item = this.#state.history?.matching[this.#state.history.highlighted];
    if (item !== undefined) {
      this.pick(item.key);
    }
  }

  /** Opens a chat from the list. */
  pick(key: number): void {
    this.closeHistory();
    this.#post({ type: 'open', key });
  }

  /** Leaves the list and returns to the chat. */
  closeHistory(): void {
    if (this.#state.history !== null) {
      this.#set({ history: null, focusComposer: this.#state.focusComposer + 1 });
    }
  }
}
