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

describe('ChatSession', () => {
  it('chooses the model, sends the message and passes the reply on', async () => {
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
    expect(sent[1]).toMatchObject({ id: 2, method: 'chat/send', params: { text: 'hello' } });
    fromCore({ method: 'chat/delta', params: { requestId: 2, text: 'Hi' } });
    fromCore({ method: 'chat/delta', params: { requestId: 99, text: 'not mine' } });
    fromCore({ method: 'chat/delta', params: { requestId: 2, text: ' there' } });
    fromCore({ id: 2, result: { stopReason: 'end' } });

    await expect(reply).resolves.toBe('end');
    expect(pieces).toEqual(['Hi', ' there']);
  });

  it('chooses the model again only when the settings or the core have changed', async () => {
    const { chat, state, fromCore, methods } = setup();
    const run = async (id: number, expectsSet: boolean): Promise<void> => {
      const reply = chat.send('hi', () => undefined);
      await settle();
      if (expectsSet) {
        fromCore({ id, result: {} });
        await settle();
      }
      fromCore({ id: expectsSet ? id + 1 : id, result: { stopReason: 'end' } });
      await reply;
    };

    await run(1, true);
    await run(3, false);
    state.settings = { provider: 'anthropic', model: 'another-model' };
    await run(4, true);
    state.generation = 2;
    await run(6, true);

    expect(methods()).toEqual([
      'model/set',
      'chat/send',
      'chat/send',
      'model/set',
      'chat/send',
      'model/set',
      'chat/send',
    ]);
  });

  it('refuses in plain words when no key is saved, and sends nothing', async () => {
    const { chat, sent } = setup({ key: undefined });

    const failure = await chat.send('hi', () => undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatError);
    expect((failure as Error).message).toContain('No API key is set');
    expect(sent).toEqual([]);
  });

  it('refuses a second message while a reply is being written', async () => {
    const { chat, fromCore } = setup();
    const first = chat.send('first', () => undefined);

    await expect(chat.send('second', () => undefined)).rejects.toThrow('still being written');
    await settle();
    fromCore({ id: 1, result: {} });
    await settle();
    fromCore({ id: 2, result: { stopReason: 'end' } });
    await expect(first).resolves.toBe('end');
    // The session is free again afterwards.
    const third = chat.send('third', () => undefined);
    await settle();
    fromCore({ id: 3, result: { stopReason: 'end' } });
    await expect(third).resolves.toBe('end');
  });

  it('turns a failed model request into a sentence about its cause', async () => {
    const { chat, fromCore } = setup();
    const reply = chat.send('hi', () => undefined);
    await settle();
    fromCore({ id: 1, result: {} });
    await settle();
    fromCore({
      id: 2,
      error: { code: -32004, message: 'the model request failed', data: { kind: 'rate_limit' } },
    });

    await expect(reply).rejects.toThrow('limiting requests');
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

  it('asks the core to stop a reply that is being written', async () => {
    const { chat, sent, fromCore } = setup();
    const reply = chat.send('hi', () => undefined);
    await settle();
    fromCore({ id: 1, result: {} });
    await settle();
    chat.cancel();

    expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', method: '$/cancel', params: { id: 2 } });
    fromCore({ id: 2, result: { stopReason: 'cancelled' } });
    await expect(reply).resolves.toBe('cancelled');
  });

  it('does nothing when no reply is being written, and does not affect the next one', async () => {
    const { chat, sent, fromCore } = setup();
    chat.cancel();
    const reply = chat.send('hi', () => undefined);
    await settle();
    fromCore({ id: 1, result: {} });
    await settle();
    fromCore({ id: 2, result: { stopReason: 'end' } });

    await expect(reply).resolves.toBe('end');
    expect(sent.some((message) => 'method' in message && message.method === '$/cancel')).toBe(
      false,
    );
  });
});
