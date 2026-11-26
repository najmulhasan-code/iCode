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
import type { Model, ModelEvent } from './model.js';
import { serve } from './server.js';

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' } },
};
const chatRequest = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'chat/send',
  params: { text: 'hi' },
});

/** A queue that is read as an async stream and can be ended or made to fail. */
function channel<T>() {
  const items: ({ value: T } | { end: true } | { error: Error })[] = [];
  let wake: (() => void) | undefined;
  const add = (item: (typeof items)[number]): void => {
    items.push(item);
    wake?.();
  };
  async function* read(): AsyncGenerator<T> {
    for (;;) {
      const item = items.shift();
      if (item === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      } else if ('end' in item) {
        return;
      } else if ('error' in item) {
        throw item.error;
      } else {
        yield item.value;
      }
    }
  }
  return {
    read,
    push: (value: T) => {
      add({ value });
    },
    end: () => {
      add({ end: true });
    },
    fail: (error: Error) => {
      add({ error });
    },
  };
}

/** A model whose replies are driven by the test, one stream per request. */
function controlledModel() {
  const streams: {
    readonly signal: AbortSignal;
    readonly events: ReturnType<typeof channel<ModelEvent>>;
    pulls: number;
  }[] = [];
  const model: Model = {
    stream(request) {
      const events = channel<ModelEvent>();
      const stream = { signal: request.signal, events, pulls: 0 };
      streams.push(stream);
      const source = events.read();
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            stream.pulls += 1;
            return source.next();
          },
        }),
      };
    },
  };
  return { model, streams };
}

const text = (value: string): ModelEvent => ({ type: 'text', text: value });
const END: ModelEvent = { type: 'end', reason: 'end' };

function connect(model: Model, write?: (text: string) => void | Promise<void>) {
  const input = channel<string>();
  const received: Message[] = [];
  const waiters: (() => void)[] = [];
  const record = (written: string): void => {
    for (const line of written.split('\n')) {
      if (line !== '') {
        received.push(parseMessage(line));
      }
    }
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  };
  const closed = serve({
    input: input.read(),
    write: write ?? record,
    model,
    info: { name: 'test-core', version: '0' },
    shutdownTimeoutMs: 200,
  });
  // The test decides whether a rejection is expected.
  closed.catch(() => undefined);
  const until = async (condition: () => boolean): Promise<void> => {
    while (!condition()) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return {
    received,
    record,
    closed,
    until,
    send: (message: unknown) => {
      input.push(`${JSON.stringify(message)}\n`);
    },
    end: input.end,
    failInput: input.fail,
    responses: (id: number) =>
      received.filter((message) => isResponse(message) && message.id === id),
    async response(id: number): Promise<Message> {
      await until(() => received.some((message) => isResponse(message) && message.id === id));
      const found = received.find((message) => isResponse(message) && message.id === id);
      if (found === undefined) {
        throw new Error('the response disappeared');
      }
      return found;
    },
  };
}

/** Lets pending promise callbacks and timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('a model that does not cooperate', () => {
  it('is cancelled even when it never answers', async () => {
    const { model, streams } = controlledModel();
    const client = connect(model);
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    client.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 2 } });

    expect(await client.response(2)).toMatchObject({ result: { stopReason: 'cancelled' } });
    expect(streams[0]?.signal.aborted).toBe(true);
  });

  it('does not keep the connection open after the client disconnects', async () => {
    const { model, streams } = controlledModel();
    const client = connect(model);
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    client.end();

    await expect(client.closed).resolves.toBeUndefined();
    expect(streams[0]?.signal.aborted).toBe(true);
  });

  it('is reported when its reply ends without an end event', async () => {
    const { model, streams } = controlledModel();
    const client = connect(model);
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    streams[0]?.events.push(text('partial'));
    streams[0]?.events.end();

    expect(await client.response(2)).toMatchObject({ error: { code: ErrorCode.InternalError } });
  });

  it('has its stop reason passed on to the client', async () => {
    const { model, streams } = controlledModel();
    const client = connect(model);
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    streams[0]?.events.push({ type: 'end', reason: 'max_tokens' });

    expect(await client.response(2)).toMatchObject({ result: { stopReason: 'max_tokens' } });
  });
});

describe('requests that overlap', () => {
  it('are answered exactly once when completion and cancellation arrive together', async () => {
    const { model, streams } = controlledModel();
    const client = connect(model);
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    streams[0]?.events.push(END);
    client.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 2 } });
    await client.response(2);
    streams[0]?.events.push(text('late'));
    await settle();

    expect(client.responses(2)).toHaveLength(1);
    expect(client.received.filter(isNotification)).toHaveLength(0);
  });

  it('run side by side and keep their pieces apart', async () => {
    const { model, streams } = controlledModel();
    const client = connect(model);
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    client.send(chatRequest(3));
    await client.response(1);
    await settle();
    streams[0]?.events.push(text('a1'));
    streams[1]?.events.push(text('b1'));
    streams[0]?.events.push(text('a2'));
    streams[1]?.events.push(END);
    streams[0]?.events.push(END);
    await client.response(2);
    await client.response(3);

    const pieces = (id: number) =>
      client.received
        .filter(isNotification)
        .map((message) => message.params as { requestId: number; text: string })
        .filter((params) => params.requestId === id)
        .map((params) => params.text);
    expect(pieces(2)).toEqual(['a1', 'a2']);
    expect(pieces(3)).toEqual(['b1']);
  });

  it('refuse an id that is still in use and accept it again afterwards', async () => {
    const { model, streams } = controlledModel();
    const client = connect(model);
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    client.send(chatRequest(2));
    expect(await client.response(2)).toMatchObject({
      error: { code: CoreErrorCode.RequestInProgress },
    });
    streams[0]?.events.push(END);
    await client.until(() => client.responses(2).length === 2);
    client.send(chatRequest(2));
    await settle();
    streams[1]?.events.push(END);
    await client.until(() => client.responses(2).length === 3);

    expect(client.responses(2).at(-1)).toMatchObject({ result: { stopReason: 'end' } });
  });
});

describe('a connection that fails', () => {
  it('stops the model and writes nothing more when reading the input fails', async () => {
    const { model, streams } = controlledModel();
    const client = connect(model);
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    client.failInput(new Error('input broke'));

    await expect(client.closed).rejects.toThrow('input broke');
    expect(streams[0]?.signal.aborted).toBe(true);
    const before = client.received.length;
    streams[0]?.events.push(text('late'));
    streams[0]?.events.push(END);
    await settle();
    expect(client.received).toHaveLength(before);
  });

  it('stops the model and does not retry when a write fails', async () => {
    const { model, streams } = controlledModel();
    let writes = 0;
    const client = connect(model, (written) => {
      writes += 1;
      if (written.includes('chat/delta')) {
        throw new Error('write failed');
      }
      client.record(written);
    });
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    streams[0]?.events.push(text('piece'));

    await expect(client.closed).rejects.toThrow('write failed');
    expect(streams[0]?.signal.aborted).toBe(true);
    expect(writes).toBe(2);
    expect(client.responses(2)).toHaveLength(0);
  });
});

describe('a client that reads slowly', () => {
  it('slows the core down, which then asks the model for no more than it can send', async () => {
    const { model, streams } = controlledModel();
    const releases: (() => void)[] = [];
    const client = connect(model, (written) => {
      if (!written.includes('chat/delta')) {
        client.record(written);
        return undefined;
      }
      return new Promise<void>((resolve) => {
        releases.push(() => {
          client.record(written);
          resolve();
        });
      });
    });
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    for (let index = 0; index < 10; index += 1) {
      streams[0]?.events.push(text(`piece ${String(index)}`));
    }
    streams[0]?.events.push(END);
    await settle();

    // One piece is being written and the client has not taken it yet.
    expect(releases).toHaveLength(1);
    expect(streams[0]?.pulls).toBe(1);

    while (client.responses(2).length === 0) {
      releases.shift()?.();
      await settle();
    }
    expect(client.received.filter(isNotification)).toHaveLength(10);
  });

  it('can still cancel a request whose output is waiting', async () => {
    const { model, streams } = controlledModel();
    const releases: (() => void)[] = [];
    const client = connect(model, (written) => {
      if (!written.includes('chat/delta')) {
        client.record(written);
        return undefined;
      }
      return new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    });
    client.send(INITIALIZE);
    client.send(chatRequest(2));
    await client.response(1);
    await settle();
    streams[0]?.events.push(text('one'));
    streams[0]?.events.push(text('two'));
    await settle();
    client.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 2 } });
    await settle();
    expect(streams[0]?.signal.aborted).toBe(true);
    releases.shift()?.();

    expect(await client.response(2)).toMatchObject({ result: { stopReason: 'cancelled' } });
    expect(streams[0]?.pulls).toBe(1);
  });
});
