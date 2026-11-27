import { ClientConnection, type Message, parseMessage } from '@icode/protocol';
import { describe, expect, it } from 'vitest';
import { ChatError, ChatSession } from './chatSession';
import type { CoreSession } from './coreProcess';
import type { ModelSettings } from './settings';

/** A promise the test settles when it chooses to. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets everything that is ready to run, run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const KEY = 'the-test-credential';

/**
 * A chat session connected to a core that the test plays. By default the key
 * and the core are available at once.
 */
function setup(options: { holdKey?: boolean; holdCore?: boolean; key?: string | undefined } = {}) {
  const sent: Message[] = [];
  const state: { settings: ModelSettings; generation: number } = {
    settings: { provider: 'anthropic' },
    generation: 1,
  };
  const key = deferred<string | undefined>();
  const core = deferred<undefined>();
  if (options.holdKey !== true) {
    key.resolve('key' in options ? options.key : KEY);
  }
  if (options.holdCore !== true) {
    core.resolve(undefined);
  }
  const holder: { chat?: ChatSession } = {};
  const connection = new ClientConnection({
    write: (text) => {
      sent.push(parseMessage(text.trimEnd()));
    },
    onNotification: (notification) => holder.chat?.handleNotification(notification),
  });
  const chat = new ChatSession({
    core: {
      session: async (): Promise<CoreSession> => {
        await core.promise;
        return { connection, generation: state.generation };
      },
    },
    readSettings: () => state.settings,
    readKey: () => key.promise,
  });
  holder.chat = chat;
  const fromCore = (message: object): void => {
    connection.receive(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const methods = () => sent.map((message) => ('method' in message ? message.method : 'response'));
  return { chat, sent, state, key, core, fromCore, methods };
}

/**
 * Plays the core while a send prepares: answers the requests that choose the
 * model and begin the conversation, and returns the id of the chat request
 * once it has been sent.
 */
async function prepare(context: ReturnType<typeof setup>): Promise<number> {
  const answered = new Set<unknown>();
  for (;;) {
    await settle();
    const last = context.sent.at(-1);
    if (last === undefined || !('method' in last) || !('id' in last) || answered.has(last.id)) {
      throw new Error('the message was not sent');
    }
    if (last.method === 'chat/send') {
      return last.id as number;
    }
    answered.add(last.id);
    context.fromCore({
      id: last.id,
      result: last.method === 'conversation/create' ? { conversationId: 'c1' } : {},
    });
  }
}

describe('ChatSession', () => {
  it('chooses the model, begins a conversation, sends the message and passes the reply on', async () => {
    const { chat, sent, fromCore } = setup();
    const pieces: string[] = [];
    const reply = chat.send('hello', (piece) => pieces.push(piece));
    await settle();

    expect(sent[0]).toMatchObject({
      method: 'model/set',
      params: { provider: 'anthropic', apiKey: KEY },
    });
    fromCore({ id: 1, result: {} });
    await settle();
    expect(sent[1]).toMatchObject({ id: 2, method: 'conversation/create' });
    fromCore({ id: 2, result: { conversationId: 'c1' } });
    await settle();
    expect(sent[2]).toMatchObject({
      id: 3,
      method: 'chat/send',
      params: { conversationId: 'c1', text: 'hello' },
    });
    fromCore({ method: 'chat/delta', params: { requestId: 3, text: 'Hi' } });
    fromCore({ method: 'chat/delta', params: { requestId: 99, text: 'not mine' } });
    fromCore({ method: 'chat/delta', params: { requestId: 3, text: ' there' } });
    fromCore({ id: 3, result: { stopReason: 'end' } });

    await expect(reply).resolves.toBe('end');
    expect(pieces).toEqual(['Hi', ' there']);
  });

  it('keeps one conversation, and chooses the model again only when something changed', async () => {
    const context = setup();
    const { chat, state, fromCore, methods } = context;
    const run = async (): Promise<void> => {
      const reply = chat.send('hi', () => undefined);
      fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
      await reply;
    };

    await run();
    await run();
    state.settings = { provider: 'anthropic', model: 'another-model' };
    await run();
    // A core that was started again knows neither the model nor the conversation.
    state.generation = 2;
    await run();

    expect(methods()).toEqual([
      'model/set',
      'conversation/create',
      'chat/send',
      'chat/send',
      'model/set',
      'chat/send',
      'model/set',
      'conversation/create',
      'chat/send',
    ]);
    const conversations = context.sent
      .filter((message) => 'method' in message && message.method === 'chat/send')
      .map((message) => (message as { params: { conversationId: string } }).params.conversationId);
    expect(conversations).toEqual(['c1', 'c1', 'c1', 'c1']);
  });

  it('refuses in plain words when no key is saved, and sends nothing', async () => {
    const { chat, sent } = setup({ key: undefined });

    const failure = await chat.send('hi', () => undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatError);
    expect((failure as Error).message).toContain('No API key is set');
    expect(sent).toEqual([]);
  });

  it('refuses a second message while a reply is being written', async () => {
    const context = setup();
    const { chat, fromCore } = context;
    const first = chat.send('first', () => undefined);

    await expect(chat.send('second', () => undefined)).rejects.toThrow('still being written');
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
    await expect(first).resolves.toBe('end');
    // The session is free again afterwards.
    const third = chat.send('third', () => undefined);
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
    await expect(third).resolves.toBe('end');
  });

  it('turns a failed model request into a sentence about its cause', async () => {
    const context = setup();
    const reply = context.chat.send('hi', () => undefined);
    context.fromCore({
      id: await prepare(context),
      error: { code: -32004, message: 'the model request failed', data: { kind: 'rate_limit' } },
    });

    await expect(reply).rejects.toThrow('limiting requests');
  });

  it('fails in plain words when the core does not name the conversation', async () => {
    const { chat, fromCore, methods } = setup();
    const reply = chat.send('hi', () => undefined);
    await settle();
    fromCore({ id: 1, result: {} });
    await settle();
    fromCore({ id: 2, result: {} });

    await expect(reply).rejects.toThrow('did not start a conversation');
    expect(methods()).toEqual(['model/set', 'conversation/create']);
  });
});

describe('ChatSession.cancel', () => {
  it('stops a send that is still reading the key, and nothing is sent', async () => {
    const { chat, sent, key } = setup({ holdKey: true });
    const reply = chat.send('hi', () => undefined);
    chat.cancel();
    key.resolve(KEY);

    await expect(reply).resolves.toBe('cancelled');
    expect(sent).toEqual([]);
  });

  it('stops a send that is waiting for the core to start, and nothing is sent', async () => {
    const { chat, sent, core } = setup({ holdCore: true });
    const reply = chat.send('hi', () => undefined);
    await settle();
    chat.cancel();
    core.resolve(undefined);

    await expect(reply).resolves.toBe('cancelled');
    expect(sent).toEqual([]);
  });

  it('stops a send that is choosing the model, and the message is not sent', async () => {
    const { chat, fromCore, methods } = setup();
    const reply = chat.send('hi', () => undefined);
    await settle();
    chat.cancel();
    fromCore({ id: 1, result: {} });

    await expect(reply).resolves.toBe('cancelled');
    expect(methods()).toEqual(['model/set']);
  });

  it('stops a send that is beginning the conversation, which the next send then uses', async () => {
    const context = setup();
    const { chat, fromCore, methods } = context;
    const reply = chat.send('hi', () => undefined);
    await settle();
    fromCore({ id: 1, result: {} });
    await settle();
    chat.cancel();
    fromCore({ id: 2, result: { conversationId: 'c1' } });

    await expect(reply).resolves.toBe('cancelled');
    expect(methods()).toEqual(['model/set', 'conversation/create']);

    const next = chat.send('again', () => undefined);
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
    await expect(next).resolves.toBe('end');
    expect(methods()).toEqual(['model/set', 'conversation/create', 'chat/send']);
  });

  it('asks the core to stop a reply that is being written', async () => {
    const context = setup();
    const { chat, sent, fromCore } = context;
    const reply = chat.send('hi', () => undefined);
    const id = await prepare(context);
    chat.cancel();

    expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', method: '$/cancel', params: { id } });
    fromCore({ id, result: { stopReason: 'cancelled' } });
    await expect(reply).resolves.toBe('cancelled');
  });

  it('does nothing when no reply is being written, and does not affect the next one', async () => {
    const context = setup();
    const { chat, sent, fromCore } = context;
    chat.cancel();
    const reply = chat.send('hi', () => undefined);
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });

    await expect(reply).resolves.toBe('end');
    expect(sent.some((message) => 'method' in message && message.method === '$/cancel')).toBe(
      false,
    );
  });
});

describe('ChatSession.setAside and resume', () => {
  it('sets the conversation aside, so the next message begins a new one', async () => {
    const context = setup();
    const { chat, fromCore, methods } = context;
    const first = chat.send('hi', () => undefined);
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
    await first;

    expect(await chat.setAside()).toEqual({ generation: 1, id: 'c1' });
    const second = chat.send('again', () => undefined);
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
    await second;
    expect(methods()).toEqual([
      'model/set',
      'conversation/create',
      'chat/send',
      'conversation/create',
      'chat/send',
    ]);
  });

  it('resolves with nothing when no conversation had begun', async () => {
    const { chat, sent } = setup();

    await expect(chat.setAside()).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('stops a reply that is being written and waits until it has ended', async () => {
    const context = setup();
    const { chat, sent, fromCore } = context;
    const reply = chat.send('hi', () => undefined);
    const id = await prepare(context);
    let setAside = false;
    const aside = chat.setAside().then((value) => {
      setAside = true;
      return value;
    });
    await settle();

    expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', method: '$/cancel', params: { id } });
    expect(setAside).toBe(false);
    fromCore({ id, result: { stopReason: 'cancelled' } });
    await expect(reply).resolves.toBe('cancelled');
    await expect(aside).resolves.toEqual({ generation: 1, id: 'c1' });
  });

  it('resumes a conversation, and the next message goes to it', async () => {
    const context = setup();
    const { chat, sent, fromCore } = context;
    const first = chat.send('hi', () => undefined);
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
    await first;
    const earlier = await chat.setAside();

    await expect(chat.resume(earlier)).resolves.toBe(true);
    const next = chat.send('back again', () => undefined);
    await settle();
    expect(sent.at(-1)).toMatchObject({
      method: 'chat/send',
      params: { conversationId: 'c1', text: 'back again' },
    });
    fromCore({ id: (sent.at(-1) as { id: number }).id, result: { stopReason: 'end' } });
    await next;
  });

  it('does not resume a conversation of a core that has stopped since, and changes nothing', async () => {
    const context = setup();
    const { chat, state, fromCore } = context;
    const first = chat.send('hi', () => undefined);
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
    await first;
    const earlier = await chat.setAside();
    state.generation = 2;

    await expect(chat.resume(earlier)).resolves.toBe(false);
    // The next message begins a new conversation in the new core.
    const next = chat.send('hi', () => undefined);
    fromCore({ id: await prepare(context), result: { stopReason: 'end' } });
    await next;
    expect(context.methods().slice(-3)).toEqual(['model/set', 'conversation/create', 'chat/send']);
  });

  it('resumes "no conversation yet" without starting the core', async () => {
    const { chat, sent } = setup({ holdCore: true });

    await expect(chat.resume(undefined)).resolves.toBe(true);
    expect(sent).toEqual([]);
  });
});
