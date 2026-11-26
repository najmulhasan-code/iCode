import {
  CoreErrorCode,
  ErrorCode,
  type Message,
  PROTOCOL_VERSION,
  isNotification,
  isResponse,
  parseMessage,
} from '@icode/protocol';
import { describe, expect, it } from 'vitest';
import { createFixedModel } from './fixedModel.js';
import type { Model } from './model.js';
import { serve } from './server.js';

const INFO = { name: 'test-core', version: '1.2.3' };
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' } },
};

const CREATE = { jsonrpc: '2.0', id: 90, method: 'conversation/create' };

/** A client connected to a core that runs in this process. */
function connect(model: Model = createFixedModel(['Hello', ', ', 'world'])) {
  const received: Message[] = [];
  const waiters: (() => void)[] = [];
  const queue: (string | null)[] = [];
  let wake: (() => void) | undefined;

  async function* input(): AsyncIterable<string> {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      } else if (next === null) {
        return;
      } else {
        yield next;
      }
    }
  }
  const feed = (item: string | null): void => {
    queue.push(item);
    wake?.();
  };

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
    createConversationId: () => 'c1',
    info: INFO,
  });

  return {
    received,
    closed,
    send: (message: unknown) => {
      feed(`${JSON.stringify(message)}\n`);
    },
    sendText: (text: string) => {
      feed(text);
    },
    end: () => {
      feed(null);
    },
    /** Waits until the core has answered the request with this id. */
    async response(id: number | null): Promise<Message> {
      for (;;) {
        const found = received.find((message) => isResponse(message) && message.id === id);
        if (found) {
          return found;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async until(condition: () => boolean): Promise<void> {
      while (!condition()) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

function deltas(received: Message[]): string[] {
  return received
    .filter(isNotification)
    .map((message) => (message.params as { text: string }).text);
}

describe('initialize', () => {
  it('answers with the protocol version and the core description', async () => {
    const client = connect();
    client.send(INITIALIZE);
    expect(await client.response(1)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: PROTOCOL_VERSION, core: INFO },
    });
  });

  it('refuses a protocol version it does not speak', async () => {
    const client = connect();
    client.send({ ...INITIALIZE, params: { ...INITIALIZE.params, protocolVersion: 99 } });
    expect(await client.response(1)).toMatchObject({
      error: { code: CoreErrorCode.UnsupportedVersion },
    });
  });

  it('refuses malformed params', async () => {
    const client = connect();
    client.send({ ...INITIALIZE, params: {} });
    expect(await client.response(1)).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
  });

  it('refuses a second initialize', async () => {
    const client = connect();
    client.send(INITIALIZE);
    client.send({ ...INITIALIZE, id: 2 });
    expect(await client.response(2)).toMatchObject({
      error: { code: CoreErrorCode.AlreadyInitialized },
    });
  });

  it('refuses any other request before initialize', async () => {
    const client = connect();
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'chat/send',
      params: { conversationId: 'c1', text: 'hi' },
    });
    expect(await client.response(1)).toMatchObject({
      error: { code: CoreErrorCode.NotInitialized },
    });
  });
});

describe('chat/send', () => {
  it('streams the reply in pieces and then answers the request', async () => {
    const client = connect();
    client.send(INITIALIZE);
    client.send(CREATE);
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'chat/send',
      params: { conversationId: 'c1', text: 'hi' },
    });
    const response = await client.response(2);

    expect(response).toEqual({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end' } });
    expect(deltas(client.received)).toEqual(['Hello', ', ', 'world']);
    expect(client.received.filter(isNotification)).toEqual(
      ['Hello', ', ', 'world'].map((text) => ({
        jsonrpc: '2.0',
        method: 'chat/delta',
        params: { requestId: 2, text },
      })),
    );
    expect(client.received.at(-1)).toBe(response);
  });

  it('stops when the client cancels the request', async () => {
    const pieces = Array.from({ length: 50 }, (_, index) => `piece ${String(index)} `);
    const client = connect(createFixedModel(pieces, 5));
    client.send(INITIALIZE);
    client.send(CREATE);
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'chat/send',
      params: { conversationId: 'c1', text: 'hi' },
    });
    await client.until(() => deltas(client.received).length > 0);
    client.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 2 } });

    expect(await client.response(2)).toMatchObject({ result: { stopReason: 'cancelled' } });
    expect(deltas(client.received).length).toBeLessThan(pieces.length);
  });

  it('refuses params without a conversation or a text', async () => {
    const client = connect();
    client.send(INITIALIZE);
    client.send({ jsonrpc: '2.0', id: 2, method: 'chat/send', params: {} });
    expect(await client.response(2)).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
  });

  it('reports a model failure without passing its details to the client', async () => {
    const failing: Model = {
      // eslint-disable-next-line require-yield
      async *stream() {
        await Promise.resolve();
        throw new Error('secret detail');
      },
    };
    const client = connect(failing);
    client.send(INITIALIZE);
    client.send(CREATE);
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'chat/send',
      params: { conversationId: 'c1', text: 'hi' },
    });
    const response = await client.response(2);

    expect(response).toMatchObject({ error: { code: ErrorCode.InternalError } });
    expect(JSON.stringify(response)).not.toContain('secret detail');
  });
});

describe('the connection', () => {
  it('answers an unknown method with an error', async () => {
    const client = connect();
    client.send(INITIALIZE);
    client.send({ jsonrpc: '2.0', id: 2, method: 'no/such/method' });
    expect(await client.response(2)).toMatchObject({ error: { code: ErrorCode.MethodNotFound } });
  });

  it('reports a line that is not a message and keeps serving', async () => {
    const client = connect();
    client.sendText('this is not json\n');
    expect(await client.response(null)).toMatchObject({ error: { code: ErrorCode.ParseError } });
    client.send(INITIALIZE);
    expect(await client.response(1)).toMatchObject({ result: { core: INFO } });
  });

  it('reads a message that arrives in several chunks', async () => {
    const client = connect();
    const text = `${JSON.stringify(INITIALIZE)}\n`;
    client.sendText(text.slice(0, 10));
    client.sendText(text.slice(10));
    expect(await client.response(1)).toMatchObject({ result: { core: INFO } });
  });

  it('stops running requests and finishes when the client disconnects', async () => {
    const pieces = Array.from({ length: 50 }, () => 'piece ');
    const client = connect(createFixedModel(pieces, 5));
    client.send(INITIALIZE);
    client.send(CREATE);
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'chat/send',
      params: { conversationId: 'c1', text: 'hi' },
    });
    await client.until(() => deltas(client.received).length > 0);
    client.end();
    await client.closed;
    expect(deltas(client.received).length).toBeLessThan(pieces.length);
  });
});
