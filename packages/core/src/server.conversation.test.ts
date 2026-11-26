import {
  CoreErrorCode,
  ErrorCode,
  type Message,
  PROTOCOL_VERSION,
  isResponse,
  parseMessage,
} from '@icode/protocol';
import { describe, expect, it } from 'vitest';
import { type ChatMessage, type Model, ModelError, type ModelEvent } from './model.js';
import { serve } from './server.js';

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' } },
};

/** What the model does with one request: the events it yields, then an optional failure. */
interface Script {
  readonly events: readonly ModelEvent[];
  readonly failure?: Error;
  /** Waits here after the events until the request is aborted. */
  readonly hang?: boolean;
}

const say = (...pieces: string[]): ModelEvent[] => pieces.map((text) => ({ type: 'text', text }));
const END: ModelEvent = { type: 'end', reason: 'end' };

/**
 * A core with a model that follows one script per request and records the
 * messages each request carried. Requests are sent one after another.
 */
function connect(scripts: readonly Script[]) {
  const seen: (readonly ChatMessage[])[] = [];
  const model: Model = {
    async *stream(request) {
      const script = scripts[seen.length];
      seen.push(request.messages);
      if (script === undefined) {
        throw new Error('the test has no script for this request');
      }
      for (const event of script.events) {
        await Promise.resolve();
        yield event;
      }
      if (script.hang === true) {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            resolve();
          });
        });
      }
      if (script.failure !== undefined) {
        throw script.failure;
      }
    },
  };
  const received: Message[] = [];
  const waiters: (() => void)[] = [];
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let created = 0;
  let nextId = 2;
  async function* input(): AsyncGenerator<string> {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        yield next;
      } else if (ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  }
  const closed = serve({
    input: input(),
    write: (text) => {
      for (const line of text.split('\n')) {
        if (line !== '') {
          received.push(parseMessage(line));
        }
      }
      for (const waiter of waiters.splice(0)) {
        waiter();
      }
    },
    model,
    createConversationId: () => {
      created += 1;
      return `c${String(created)}`;
    },
    info: { name: 'test-core', version: '0' },
    log: () => undefined,
  });
  const send = (message: object): void => {
    pending.push(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    wake?.();
  };
  const response = async (id: number): Promise<Message> => {
    for (;;) {
      const found = received.find((message) => isResponse(message) && message.id === id);
      if (found !== undefined) {
        return found;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  send(INITIALIZE);
  return {
    seen,
    received,
    send,
    response,
    /** Sends a request and waits for its answer. */
    async request(method: string, params?: object): Promise<Message> {
      const id = nextId;
      nextId += 1;
      send({ id, method, params });
      return response(id);
    },
    /** Sends a chat message without waiting. Returns the id of the request. */
    start(conversationId: string, text: string): number {
      const id = nextId;
      nextId += 1;
      send({ id, method: 'chat/send', params: { conversationId, text } });
      return id;
    },
    async end(): Promise<void> {
      ended = true;
      wake?.();
      await closed;
    },
  };
}

describe('conversation/create', () => {
  it('answers with a new id each time', async () => {
    const client = connect([]);

    expect(await client.request('conversation/create')).toMatchObject({
      result: { conversationId: 'c1' },
    });
    expect(await client.request('conversation/create')).toMatchObject({
      result: { conversationId: 'c2' },
    });
    await client.end();
  });

  it('names conversations with random ids when none are supplied', async () => {
    let written = '';
    async function* input(): AsyncGenerator<string> {
      await Promise.resolve();
      yield `${JSON.stringify(INITIALIZE)}\n`;
      yield `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'conversation/create' })}\n`;
      yield `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'conversation/create' })}\n`;
    }
    await serve({
      input: input(),
      write: (text) => {
        written += text;
      },
      info: { name: 'test-core', version: '0' },
    });
    const ids = written
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => parseMessage(line))
      .flatMap((message) =>
        'result' in message ? [(message.result as { conversationId?: string }).conversationId] : [],
      )
      .filter((id) => id !== undefined);

    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('a conversation', () => {
  it('sends every kept turn with each new message', async () => {
    const client = connect([
      { events: [...say('One', '.'), END] },
      { events: [...say('Two.'), END] },
      { events: [END] },
    ]);
    await client.request('conversation/create');
    await client.request('chat/send', { conversationId: 'c1', text: 'first' });
    await client.request('chat/send', { conversationId: 'c1', text: 'second' });
    await client.request('chat/send', { conversationId: 'c1', text: 'third' });

    expect(client.seen[2]).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'One.' },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'Two.' },
      { role: 'user', text: 'third' },
    ]);
    await client.end();
  });

  it('is kept apart from other conversations', async () => {
    const client = connect([
      { events: [...say('A.'), END] },
      { events: [...say('B.'), END] },
      { events: [END] },
    ]);
    await client.request('conversation/create');
    await client.request('conversation/create');
    await client.request('chat/send', { conversationId: 'c1', text: 'to the first' });
    await client.request('chat/send', { conversationId: 'c2', text: 'to the second' });
    await client.request('chat/send', { conversationId: 'c1', text: 'again' });

    expect(client.seen[1]).toEqual([{ role: 'user', text: 'to the second' }]);
    expect(client.seen[2]).toEqual([
      { role: 'user', text: 'to the first' },
      { role: 'assistant', text: 'A.' },
      { role: 'user', text: 'again' },
    ]);
    await client.end();
  });

  it('keeps a reply that reached the output limit', async () => {
    const client = connect([
      { events: [...say('Half a'), { type: 'end', reason: 'max_tokens' }] },
      { events: [END] },
    ]);
    await client.request('conversation/create');
    await client.request('chat/send', { conversationId: 'c1', text: 'first' });
    await client.request('chat/send', { conversationId: 'c1', text: 'go on' });

    expect(client.seen[1]).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'Half a' },
      { role: 'user', text: 'go on' },
    ]);
    await client.end();
  });

  it('keeps what was written of a reply the user stopped', async () => {
    const client = connect([{ events: say('Partly'), hang: true }, { events: [END] }]);
    await client.request('conversation/create');
    const id = client.start('c1', 'first');
    while (!client.received.some((message) => 'method' in message)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    client.send({ method: '$/cancel', params: { id } });
    expect(await client.response(id)).toMatchObject({ result: { stopReason: 'cancelled' } });
    await client.request('chat/send', { conversationId: 'c1', text: 'go on' });

    expect(client.seen[1]).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'Partly' },
      { role: 'user', text: 'go on' },
    ]);
    await client.end();
  });

  it.each<[string, Script, object]>([
    [
      'failed',
      { events: say('Partly'), failure: new ModelError('overloaded', 'detail', 529) },
      { error: { code: CoreErrorCode.ModelRequestFailed } },
    ],
    [
      'was declined',
      { events: [...say('I'), { type: 'end', reason: 'refusal' }] },
      { result: { stopReason: 'refusal' } },
    ],
    ['ended without any text', { events: [END] }, { result: { stopReason: 'end' } }],
    [
      'was stopped before any text',
      { events: [], hang: true },
      { result: { stopReason: 'cancelled' } },
    ],
  ])('keeps nothing of a turn that %s', async (name, script, answer) => {
    const client = connect([script, { events: [END] }]);
    await client.request('conversation/create');
    const id = client.start('c1', 'first');
    if (name === 'was stopped before any text') {
      while (client.seen.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      client.send({ method: '$/cancel', params: { id } });
    }
    expect(await client.response(id)).toMatchObject(answer);
    await client.request('chat/send', { conversationId: 'c1', text: 'second' });

    expect(client.seen[1]).toEqual([{ role: 'user', text: 'second' }]);
    await client.end();
  });

  it('takes one message at a time, and the next as soon as the reply has been answered', async () => {
    const client = connect([{ events: say('Partly'), hang: true }, { events: [END] }]);
    await client.request('conversation/create');
    const first = client.start('c1', 'first');
    const early = client.start('c1', 'too early');

    expect(await client.response(early)).toMatchObject({
      error: { code: CoreErrorCode.ConversationBusy },
    });
    client.send({ method: '$/cancel', params: { id: first } });
    await client.response(first);
    expect(await client.request('chat/send', { conversationId: 'c1', text: 'now' })).toMatchObject({
      result: { stopReason: 'end' },
    });
    expect(client.seen).toHaveLength(2);
    await client.end();
  });
});

describe('chat/send', () => {
  it('is refused for a conversation that does not exist', async () => {
    const client = connect([]);

    expect(
      await client.request('chat/send', { conversationId: 'nowhere', text: 'hi' }),
    ).toMatchObject({ error: { code: CoreErrorCode.UnknownConversation } });
    expect(client.seen).toHaveLength(0);
    await client.end();
  });

  it.each([
    ['no conversation', { text: 'hi' }],
    ['a conversation that is not text', { conversationId: 5, text: 'hi' }],
    ['no text', { conversationId: 'c1' }],
    ['an empty text', { conversationId: 'c1', text: '' }],
    ['a text of white space', { conversationId: 'c1', text: ' \n\t' }],
  ])('is refused with %s', async (_name, params) => {
    const client = connect([]);
    await client.request('conversation/create');

    expect(await client.request('chat/send', params)).toMatchObject({
      error: { code: ErrorCode.InvalidParams },
    });
    expect(client.seen).toHaveLength(0);
    await client.end();
  });
});
