import type { StopReason } from '@icode/protocol';
import { describe, expect, it } from 'vitest';
import { type ChatBackend, ChatPanelController, type PanelMessage } from './chatPanel';
import { ConversationLostError, type ConversationRef } from './chatSession';

type ShowMessage = Extract<PanelMessage, { type: 'show' }>;

/**
 * A chat backend the test drives: each send waits until the test ends it.
 * Like the real session, a send begins a conversation when there is none, and
 * refuses one that the engine has lost.
 */
function fakeChat() {
  const sends: {
    text: string;
    conversation: string;
    piece: (text: string) => void;
    end: (stopReason: StopReason) => void;
    fail: (message: string) => void;
  }[] = [];
  let cancels = 0;
  let created = 0;
  const state: {
    current: ConversationRef | undefined;
    /** Conversations the engine has lost. */
    lost: Set<string>;
    /** While set, resuming waits for it. */
    hold?: Promise<void> | undefined;
  } = { current: undefined, lost: new Set() };
  const backend: ChatBackend = {
    send: (text, onText) => {
      if (state.current !== undefined && state.lost.has(state.current.id)) {
        return Promise.reject(new ConversationLostError());
      }
      return new Promise((resolve, reject) => {
        if (state.current === undefined) {
          created += 1;
          state.current = { generation: 1, id: `c${String(created)}` };
        }
        sends.push({
          text,
          conversation: state.current.id,
          piece: onText,
          end: resolve,
          fail: (message) => {
            reject(new Error(message));
          },
        });
      });
    },
    cancel: () => {
      cancels += 1;
    },
    setAside: () => {
      const current = state.current;
      state.current = undefined;
      return Promise.resolve(current);
    },
    resume: async (conversation) => {
      await state.hold;
      state.current = conversation;
    },
  };
  return { backend, sends, state, cancels: () => cancels };
}

/** Lets everything that is ready to run, run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A page as the controller sees it. Like the real page, it confirms each
 * `show` with the unsent text of the chat it leaves, and it keeps the text in
 * its composer. A held page receives `show` messages but confirms them only
 * when the test delivers them, as a page that is behind would.
 */
function page(controller: ChatPanelController, options: { held?: boolean } = {}) {
  /** Every message except `show`. */
  const posted: PanelMessage[] = [];
  /** The `show` messages the page has acted on. */
  const shows: ShowMessage[] = [];
  const queue: ShowMessage[] = [];
  const state = { key: undefined as number | undefined, draft: '' };
  const port = {
    posted,
    shows,
    get key() {
      return state.key;
    },
    get draft() {
      return state.draft;
    },
    post: (message: PanelMessage) => {
      if (message.type !== 'show') {
        posted.push(message);
      } else if (options.held === true) {
        queue.push(message);
      } else {
        confirm(message);
      }
    },
    /** Acts on the `show` messages that were held back, in order. */
    deliver: () => {
      for (const message of queue.splice(0)) {
        confirm(message);
      }
    },
    /** Types into the composer, which reports the text. */
    type: (text: string) => {
      state.draft = text;
      controller.handle(port, { type: 'draft', chat: state.key, text });
    },
    /** Sends a message from the composer, in the chat the page shows. */
    send: (id: number, text: string) => {
      controller.handle(port, { type: 'send', chat: state.key, id, text });
    },
  };
  function confirm(message: ShowMessage): void {
    const left = state.key === undefined ? null : { key: state.key, draft: state.draft };
    controller.handle(port, { type: 'switched', seq: message.seq, left });
    state.key = message.key;
    if (!message.carry) {
      state.draft = message.draft;
    }
    shows.push(message);
  }
  return port;
}

async function setup() {
  const chat = fakeChat();
  const clock = { now: 1_000_000 };
  const controller = new ChatPanelController(chat.backend, () => clock.now);
  const port = page(controller);
  controller.attach(port);
  await settle();
  return { ...chat, clock, controller, port };
}

type Context = Awaited<ReturnType<typeof setup>>;

/** Sends one message from the page and lets its reply end. */
async function exchange(context: Context, id: number, text: string, reply = 'ok') {
  context.port.send(id, text);
  context.sends.at(-1)?.piece(reply);
  context.sends.at(-1)?.end('end');
  await settle();
}

describe('a message from the page', () => {
  it('is sent, and its pieces and its end go back with the same number', async () => {
    const { port, sends } = await setup();
    port.send(7, '  hello  ');

    expect(sends[0]?.text).toBe('hello');
    sends[0]?.piece('Hi');
    sends[0]?.piece(' there');
    sends[0]?.end('end');
    await settle();
    expect(port.posted).toEqual([
      { type: 'text', id: 7, text: 'Hi' },
      { type: 'text', id: 7, text: ' there' },
      { type: 'end', id: 7, stopReason: 'end' },
    ]);
  });

  it('gets the failure in words when the request fails', async () => {
    const { port, sends } = await setup();
    port.send(1, 'hello');
    sends[0]?.fail('The provider rejected the API key.');
    await settle();

    expect(port.posted).toEqual([
      { type: 'error', id: 1, message: 'The provider rejected the API key.' },
    ]);
  });

  it('is refused at once when it is empty, nothing is sent, and the page takes it back', async () => {
    const { port, sends } = await setup();
    port.send(1, '   ');

    expect(sends).toHaveLength(0);
    expect(port.posted).toEqual([
      { type: 'error', id: 1, message: 'The message is empty.', withdraw: true },
    ]);
  });

  it('is refused at once when a reply is still being written', async () => {
    const { port, sends } = await setup();
    port.send(1, 'first');
    port.send(2, 'second');

    expect(sends).toHaveLength(1);
    expect(port.posted).toEqual([
      {
        type: 'error',
        id: 2,
        message: 'A reply is still being written. Wait for it or stop it first.',
        withdraw: true,
      },
    ]);
    sends[0]?.end('end');
    await settle();
    expect(port.posted.at(-1)).toEqual({ type: 'end', id: 1, stopReason: 'end' });
  });

  it.each([
    ['nothing', undefined],
    ['text', 'send'],
    ['an array', [{ type: 'send', id: 1, text: 'x' }]],
    ['an unknown type', { type: 'run', command: 'x' }],
    ['a send without a number', { type: 'send', chat: 1, text: 'x' }],
    ['a send whose text is not text', { type: 'send', chat: 1, id: 1, text: 5 }],
  ])('is ignored when it is %s', async (_name, message) => {
    const { controller, port, sends } = await setup();
    controller.handle(port, message);

    expect(sends).toHaveLength(0);
    expect(port.posted).toEqual([]);
  });

  it('is refused when it names no chat, or a chat the page does not show', async () => {
    const { controller, port, sends } = await setup();
    controller.handle(port, { type: 'send', id: 1, text: 'a' });
    controller.handle(port, { type: 'send', chat: 99, id: 2, text: 'b' });

    expect(sends).toHaveLength(0);
    expect(port.posted.map((message) => message.type)).toEqual(['error', 'error']);
  });

  it('can stop the reply, and only while one is being written', async () => {
    const { controller, port, sends, cancels } = await setup();
    controller.handle(port, { type: 'cancel' });
    expect(cancels()).toBe(0);

    port.send(1, 'hello');
    controller.handle(port, { type: 'cancel' });
    expect(cancels()).toBe(1);
    sends[0]?.end('cancelled');
    await settle();
    expect(port.posted).toEqual([{ type: 'end', id: 1, stopReason: 'cancelled' }]);
  });
});

describe('a page that opens', () => {
  it('is shown the current chat, empty at first', async () => {
    const { port } = await setup();

    expect(port.shows).toEqual([
      { type: 'show', seq: 1, key: port.key, entries: [], draft: '', carry: false },
    ]);
  });

  it('after another page closed, is shown the same chat with its messages and unsent text', async () => {
    const context = await setup();
    const { controller, port: first } = context;
    await exchange(context, 1, 'hello', 'Hi.');
    first.type('half a thought');
    controller.detach(first);

    const second = page(controller);
    controller.attach(second);
    await settle();
    expect(second.shows[0]).toMatchObject({
      key: first.key,
      entries: [
        { kind: 'user', text: 'hello' },
        { kind: 'reply', text: 'Hi.', stopReason: 'end' },
      ],
      draft: 'half a thought',
    });
    // The conversation goes on where it was.
    second.send(1, 'and then?');
    expect(context.sends.at(-1)?.conversation).toBe('c1');
  });

  it('while a reply is being written, stops it and is shown the chat once the reply is recorded', async () => {
    const { controller, port: first, sends, cancels } = await setup();
    first.send(1, 'old question');
    sends[0]?.piece('old ');
    controller.detach(first);
    expect(cancels()).toBe(1);

    const second = page(controller);
    controller.attach(second);
    await settle();
    expect(second.shows).toEqual([]);
    // The stopped reply winds down after the first page is gone.
    sends[0]?.piece('reply');
    sends[0]?.end('cancelled');
    await settle();
    expect(first.posted).toEqual([{ type: 'text', id: 1, text: 'old ' }]);
    expect(second.posted).toEqual([]);
    expect(second.shows[0]?.entries).toEqual([
      { kind: 'user', text: 'old question' },
      { kind: 'reply', text: 'old reply', stopReason: 'cancelled' },
    ]);
  });

  it('refuses a message sent before it was shown its chat', async () => {
    const context = await setup();
    const { controller, port: first, sends } = context;
    await exchange(context, 1, 'old question');
    const second = page(controller, { held: true });
    controller.attach(second);
    await settle();
    controller.handle(second, { type: 'send', chat: first.key, id: 1, text: 'too early' });

    expect(sends).toHaveLength(1);
    expect(second.posted).toEqual([
      {
        type: 'error',
        id: 1,
        message: 'The chat is being switched. Send the message again in a moment.',
        withdraw: true,
      },
    ]);
    second.deliver();
    await settle();
    second.send(2, 'now');
    expect(sends[1]?.text).toBe('now');
  });

  it('makes the controller ignore messages from the page that is gone', async () => {
    const { controller, port: first, sends } = await setup();
    controller.attach(page(controller));
    await settle();
    first.send(1, 'from the old page');

    expect(sends).toHaveLength(0);
  });
});

describe('submit', () => {
  /** Plays the page's script for one submission and returns what the test learns. */
  async function submitThrough(
    context: Context,
    text: string,
    reply: (send: Context['sends'][number]) => void,
    id: number,
  ) {
    const { controller, port, sends } = context;
    const before = sends.length;
    const result = controller.submit(text);
    await settle();
    const request = port.posted.at(-1);
    if (request?.type !== 'submit') {
      throw new Error('no submit message was posted');
    }
    controller.handle(port, {
      type: 'send',
      chat: port.key,
      id,
      text: request.text,
      token: request.token,
    });
    const send = sends[before];
    if (send === undefined) {
      throw new Error('the message was not sent');
    }
    reply(send);
    await settle();
    const shown = port.posted
      .filter((message) => message.type === 'text' && message.id === id)
      .map((message) => (message as { text: string }).text)
      .join('');
    controller.handle(port, { type: 'shown', id, text: shown });
    return result;
  }

  it('resolves with the outcome of its own message and what the page showed', async () => {
    const context = await setup();
    const first = await submitThrough(
      context,
      'one',
      (send) => {
        send.piece('first reply');
        send.end('end');
      },
      1,
    );
    const second = await submitThrough(
      context,
      'two',
      (send) => {
        send.piece('second reply');
        send.end('max_tokens');
      },
      2,
    );

    expect(first).toEqual({ text: 'first reply', stopReason: 'end', shown: 'first reply' });
    expect(second).toEqual({
      text: 'second reply',
      stopReason: 'max_tokens',
      shown: 'second reply',
    });
  });

  it('waits until a page that has just opened was shown its chat', async () => {
    const chat = fakeChat();
    const controller = new ChatPanelController(chat.backend);
    const port = page(controller, { held: true });
    controller.attach(port);
    void controller.submit('hello');
    await settle();
    expect(port.posted).toEqual([]);

    port.deliver();
    await settle();
    expect(port.posted).toMatchObject([{ type: 'submit', text: 'hello' }]);
  });

  it.each([
    ['an empty message', '   '],
    ['a message of line breaks', '\n\n'],
  ])('answers %s at once', async (_name, text) => {
    const { controller, port } = await setup();

    await expect(controller.submit(text)).resolves.toEqual({ error: 'The message is empty.' });
    expect(port.posted).toEqual([]);
  });

  it('answers at once when no page is open', async () => {
    const controller = new ChatPanelController(fakeChat().backend);

    await expect(controller.submit('hello')).resolves.toEqual({
      error: 'The chat panel is not open.',
    });
  });

  it('is answered when the page does not accept the message', async () => {
    const { controller, port } = await setup();
    const result = controller.submit('hello');
    await settle();
    const request = port.posted[0] as { token: number };
    controller.handle(port, { type: 'rejected', token: request.token });

    await expect(result).resolves.toEqual({ error: 'The chat panel did not accept the message.' });
  });

  it('is answered when the page closes first', async () => {
    const { controller, port } = await setup();
    const result = controller.submit('hello');
    await settle();
    controller.detach(port);

    await expect(result).resolves.toEqual({ error: 'The chat panel was closed.' });
  });
});

describe('a new chat', () => {
  it('changes nothing when nothing was sent yet, and puts the cursor in the composer', async () => {
    const { controller, port } = await setup();

    await expect(controller.newChat()).resolves.toBe('empty');
    expect(port.posted).toEqual([{ type: 'focus' }]);
    expect(port.shows).toHaveLength(1);
  });

  it('shows an empty chat, and its first message begins a new conversation', async () => {
    const context = await setup();
    const { controller, port, sends } = context;
    await exchange(context, 1, 'hello');
    const first = port.key;

    await expect(controller.newChat()).resolves.toBe('started');
    expect(port.key).not.toBe(first);
    expect(port.shows.at(-1)).toMatchObject({ entries: [], draft: '', carry: false });
    port.send(2, 'a new topic');
    expect(sends.at(-1)?.conversation).toBe('c2');
  });

  it('stops a reply that is being written, and switches only after its end reached the page', async () => {
    const { controller, port, sends, cancels } = await setup();
    port.send(1, 'hello');
    const started = controller.newChat();
    await settle();
    expect(cancels()).toBe(1);
    expect(port.shows).toHaveLength(1);

    sends[0]?.end('cancelled');
    await expect(started).resolves.toBe('started');
    expect(port.posted.at(-1)).toEqual({ type: 'end', id: 1, stopReason: 'cancelled' });
    expect(port.shows).toHaveLength(2);
  });

  it('refuses a message sent while the chat is being switched, and accepts one right after', async () => {
    const context = await setup();
    const { controller, port, sends } = context;
    port.send(1, 'hello');
    const started = controller.newChat();
    port.send(2, 'during the switch');
    expect(port.posted.at(-1)).toMatchObject({ type: 'error', id: 2, withdraw: true });

    sends[0]?.end('cancelled');
    await started;
    port.send(3, 'after the switch');
    expect(sends.at(-1)?.text).toBe('after the switch');
  });

  it('does nothing without an open page', async () => {
    const controller = new ChatPanelController(fakeChat().backend);

    await expect(controller.newChat()).resolves.toBe('closed');
  });
});

describe('the chat list', () => {
  it('lists the chats that hold anything, the most recently used first', async () => {
    const context = await setup();
    const { controller, clock } = context;
    await exchange(context, 1, 'first topic');
    const first = context.port.key;
    clock.now += 60_000;
    await controller.newChat();
    await exchange(context, 2, 'second topic');
    clock.now += 60_000;
    await controller.newChat();

    // The empty chat on screen is not listed.
    expect(controller.chats()).toEqual([
      {
        key: (first ?? 0) + 1,
        text: 'second topic',
        lastUsed: 1_060_000,
        current: false,
        notSent: false,
        lost: false,
      },
      {
        key: first,
        text: 'first topic',
        lastUsed: 1_000_000,
        current: false,
        notSent: false,
        lost: false,
      },
    ]);
  });

  it('lists a chat that holds only unsent text, so it can be reached again', async () => {
    const context = await setup();
    const { controller, port } = context;
    await exchange(context, 1, 'first topic');
    const first = port.key ?? 0;
    await controller.newChat();
    const second = port.key;
    port.type('not sent yet');
    await controller.open(first);

    expect(controller.chats()).toContainEqual(
      expect.objectContaining({ key: second, text: 'not sent yet', notSent: true }),
    );
    await expect(controller.open(second ?? 0)).resolves.toBe('opened');
    expect(port.draft).toBe('not sent yet');
  });

  it('forgets a chat that was left with nothing in it', async () => {
    const context = await setup();
    const { controller, port } = context;
    await exchange(context, 1, 'first topic');
    const first = port.key ?? 0;
    await controller.newChat();
    const empty = port.key ?? 0;
    await controller.open(first);

    expect(controller.chats().map((chat) => chat.key)).toEqual([first]);
    await expect(controller.open(empty)).resolves.toBe('gone');
  });

  it('opens a chat with its messages and unsent text, and the model continues it', async () => {
    const context = await setup();
    const { controller, port, sends } = context;
    await exchange(context, 1, 'the word is apple', 'Noted.');
    const first = port.key ?? 0;
    port.type('draft of the first');
    await controller.newChat();
    await exchange(context, 2, 'a new topic');

    await expect(controller.open(first)).resolves.toBe('opened');
    expect(port.shows.at(-1)).toMatchObject({
      key: first,
      entries: [
        { kind: 'user', text: 'the word is apple' },
        { kind: 'reply', text: 'Noted.', stopReason: 'end' },
      ],
      draft: 'draft of the first',
    });
    port.send(3, 'what was the word?');
    expect(sends.at(-1)?.conversation).toBe('c1');
  });

  it('marks the chat on screen as current, and opening it changes nothing', async () => {
    const context = await setup();
    const { controller, port } = context;
    await exchange(context, 1, 'hello');

    expect(controller.chats()[0]?.current).toBe(true);
    await expect(controller.open(port.key ?? 0)).resolves.toBe('current');
    expect(port.shows).toHaveLength(1);
    expect(port.posted.at(-1)).toEqual({ type: 'focus' });
  });

  it('says so for a chat it does not know, or when no page is open', async () => {
    const { controller } = await setup();
    await expect(controller.open(99)).resolves.toBe('gone');

    const closed = new ChatPanelController(fakeChat().backend);
    await expect(closed.open(1)).resolves.toBe('closed');
  });
});

describe('switches while the page is behind', () => {
  it('keep the latest unsent text through a quick switch away and back', async () => {
    const chat = fakeChat();
    const controller = new ChatPanelController(chat.backend);
    const port = page(controller, { held: true });
    controller.attach(port);
    await settle();
    port.deliver();
    await settle();
    port.send(1, 'topic A');
    chat.sends[0]?.end('end');
    await settle();
    const a = port.key ?? 0;
    port.type('draft A');

    // The switch away and the switch back are both asked for before the page
    // has acted on either, and the user goes on typing in A meanwhile.
    const away = controller.newChat();
    const back = controller.open(a);
    await settle();
    port.type('draft A, longer');
    port.deliver();
    await away;
    port.type('draft B');
    await settle();
    port.deliver();
    await back;

    expect(port.key).toBe(a);
    expect(port.draft).toBe('draft A, longer');
    expect(controller.chats()).toContainEqual(
      expect.objectContaining({ text: 'draft B', notSent: true }),
    );
  });

  it('ignore unsent text that arrives for a chat the page no longer shows', async () => {
    const context = await setup();
    const { controller, port } = context;
    await exchange(context, 1, 'topic A');
    const a = port.key;
    port.type('draft A');
    await controller.newChat();
    controller.handle(port, { type: 'draft', chat: a, text: 'late' });
    await controller.open(a ?? 0);

    expect(port.draft).toBe('draft A');
  });

  it('end when the page closes, and the next page is shown the chat the core has', async () => {
    const chat = fakeChat();
    const controller = new ChatPanelController(chat.backend);
    const first = page(controller, { held: true });
    controller.attach(first);
    await settle();
    first.deliver();
    await settle();
    first.send(1, 'topic A');
    chat.sends[0]?.end('end');
    await settle();

    const started = controller.newChat();
    await settle();
    controller.detach(first);
    await expect(started).resolves.toBe('started');
    const second = page(controller);
    controller.attach(second);
    await settle();
    first.deliver();

    expect(second.shows).toHaveLength(1);
    expect(second.shows[0]?.entries).toEqual([]);
    second.send(1, 'fresh');
    expect(chat.sends.at(-1)?.conversation).toBe('c2');
  });

  it('end when the page closes while a chat is being opened, and the next page shows that chat', async () => {
    const context = await setup();
    const { controller, port, state, sends } = context;
    await exchange(context, 1, 'topic A');
    const a = port.key ?? 0;
    await controller.newChat();
    await exchange(context, 2, 'topic B');

    let release!: () => void;
    state.hold = new Promise((resolve) => {
      release = resolve;
    });
    const opening = controller.open(a);
    await settle();
    controller.detach(port);
    const second = page(controller);
    controller.attach(second);
    release();
    await expect(opening).resolves.toBe('closed');
    await settle();

    expect(second.shows).toHaveLength(1);
    expect(second.shows[0]).toMatchObject({
      key: a,
      entries: [{ text: 'topic A' }, { text: 'ok' }],
    });
    second.send(3, 'more on A');
    expect(sends.at(-1)?.conversation).toBe('c1');
  });
});

describe("a chat that iCode's engine has lost", () => {
  async function lostChat() {
    const context = await setup();
    await exchange(context, 1, 'topic A');
    context.state.lost.add('c1');
    context.port.send(2, 'and then?');
    await settle();
    return context;
  }

  it('refuses the message, gives it back to the composer, and stays listed and readable', async () => {
    const { controller, port, sends } = await lostChat();

    expect(port.posted.at(-1)).toEqual({
      type: 'error',
      id: 2,
      message: new ConversationLostError().message,
      withdraw: true,
    });
    expect(controller.chats()).toEqual([
      expect.objectContaining({ text: 'topic A', current: true, lost: true }),
    ]);
    // Opened again from a new page, it shows what happened.
    controller.detach(port);
    const second = page(controller);
    controller.attach(second);
    await settle();
    expect(second.shows[0]?.entries).toEqual([
      { kind: 'user', text: 'topic A' },
      { kind: 'reply', text: 'ok', stopReason: 'end' },
      { kind: 'error', text: new ConversationLostError().message },
    ]);
    // Later messages are refused before anything is sent.
    second.send(3, 'still there?');
    expect(sends).toHaveLength(1);
    expect(second.posted.at(-1)).toMatchObject({ type: 'error', id: 3, withdraw: true });
  });

  it('carries the unsent text into a new chat, which the model can continue', async () => {
    const { controller, port, sends } = await lostChat();
    // The page put the refused message back into the composer.
    port.type('and then?');

    await expect(controller.newChat()).resolves.toBe('started');
    expect(port.shows.at(-1)).toMatchObject({ carry: true });
    expect(port.draft).toBe('and then?');
    expect(controller.chats()).toEqual([
      expect.objectContaining({ text: 'and then?', current: true, notSent: true }),
      expect.objectContaining({ text: 'topic A', lost: true }),
    ]);
    port.send(3, 'and then?');
    expect(sends.at(-1)?.conversation).toBe('c2');
  });

  it('keeps the refused message as unsent text when the page had closed', async () => {
    const context = await setup();
    const { controller, port, state } = context;
    await exchange(context, 1, 'topic A');
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = context.backend.send.bind(context.backend);
    context.backend.send = async (text, onText) => {
      await late;
      return send(text, onText);
    };
    state.lost.add('c1');
    port.send(2, 'and then?');
    controller.detach(port);
    release();
    await settle();

    const second = page(controller);
    controller.attach(second);
    await settle();
    expect(second.draft).toBe('and then?');
  });
});
