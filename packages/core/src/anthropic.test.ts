import { type IncomingHttpHeaders, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ANTHROPIC_MODEL, createAnthropicModel } from './anthropic.js';
import { PROTOCOL_VERSION } from '@icode/protocol';
import type { Model, ModelEvent } from './model.js';
import { serve } from './server.js';
import { type Behaviour, describeModelContract } from './testing/modelContract.js';

interface SeenRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

type Handler = (response: ServerResponse, request: SeenRequest, count: number) => void;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/** A local server that stands in for the Anthropic API. */
async function standIn(handler: Handler) {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('end', () => {
      const seen: SeenRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(text) as Record<string, unknown>,
      };
      requests.push(seen);
      handler(response, seen, requests.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, requests };
}

function writeEvents(response: ServerResponse, events: readonly Record<string, unknown>[]): void {
  for (const event of events) {
    response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}

function startStream(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
}

function replyEvents(pieces: readonly string[], stopReason: string, model = 'stand-in-model') {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...pieces.map((text) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    { type: 'message_stop' },
  ];
}

function sendReply(response: ServerResponse, pieces: readonly string[], stopReason: string): void {
  startStream(response);
  writeEvents(response, replyEvents(pieces, stopReason));
  response.end();
}

function sendError(response: ServerResponse, status: number, type: string): void {
  response.writeHead(status, { 'content-type': 'application/json', 'retry-after-ms': '1' });
  response.end(JSON.stringify({ type: 'error', error: { type, message: `stand-in ${type}` } }));
}

async function collect(model: Model, signal?: AbortSignal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  const request = {
    messages: [{ role: 'user', text: 'hi' }] as const,
    signal: signal ?? new AbortController().signal,
  };
  for await (const event of model.stream(request)) {
    events.push(event);
  }
  return events;
}

function modelFor(
  url: string,
  extra: { model?: string; maxTokens?: number; retries?: number } = {},
) {
  return createAnthropicModel({
    apiKey: 'test-key',
    baseURL: url,
    maxRetries: extra.retries ?? 0,
    ...(extra.model === undefined ? {} : { model: extra.model }),
    ...(extra.maxTokens === undefined ? {} : { maxTokens: extra.maxTokens }),
  });
}

describe('a reply', () => {
  it('is passed on as text events followed by one end event', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['Hello', ', ', 'world'], 'end_turn');
    });

    expect(await collect(modelFor(api.url))).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'world' },
      {
        type: 'end',
        reason: 'end',
        usage: { inputTokens: 12, outputTokens: 7 },
        model: 'stand-in-model',
      },
    ]);
  });

  it('is requested with the key, the model, the conversation and the fallback option', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['ok'], 'end_turn');
    });
    await collect(modelFor(api.url));

    const [request] = api.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toMatch(/^\/v1\/messages/);
    expect(request?.headers.authorization).toBe('Bearer test-key');
    expect(request?.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(request?.body).toMatchObject({
      model: DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 64000,
      stream: true,
      fallbacks: 'default',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('uses the model and the token limit it was configured with', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['ok'], 'end_turn');
    });
    await collect(modelFor(api.url, { model: 'another-model', maxTokens: 1000 }));

    expect(api.requests[0]?.body).toMatchObject({ model: 'another-model', max_tokens: 1000 });
  });

  it('names the model that took over after a fallback, including a second one', async () => {
    const api = await standIn((response) => {
      startStream(response);
      const events: Record<string, unknown>[] = replyEvents(['answer'], 'end_turn', 'first-model');
      const fallback = (from: string, to: string) => ({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: from },
          to: { model: to },
          trigger: { type: 'refusal', category: null },
        },
      });
      events.splice(1, 0, fallback('first-model', 'second-model'), {
        type: 'content_block_stop',
        index: 0,
      });
      events.splice(3, 0, fallback('second-model', 'third-model'), {
        type: 'content_block_stop',
        index: 0,
      });
      writeEvents(response, events);
      response.end();
    });

    expect((await collect(modelFor(api.url))).at(-1)).toMatchObject({
      type: 'end',
      model: 'third-model',
    });
  });

  it('leaves out content that is not text', async () => {
    const api = await standIn((response) => {
      startStream(response);
      const events = replyEvents(['answer'], 'end_turn');
      events.splice(2, 0, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'private reasoning' },
      } as never);
      writeEvents(response, events);
      response.end();
    });

    const texts = (await collect(modelFor(api.url))).filter((event) => event.type === 'text');
    expect(texts).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it.each([
    ['end_turn', 'end'],
    ['stop_sequence', 'end'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'max_tokens'],
    ['refusal', 'refusal'],
  ])('that stops with %s is reported as %s', async (stopReason, expected) => {
    const api = await standIn((response) => {
      sendReply(response, ['x'], stopReason);
    });

    expect((await collect(modelFor(api.url))).at(-1)).toMatchObject({
      type: 'end',
      reason: expected,
    });
  });

  it('that stops to call a tool is an error, because no tools were offered', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['x'], 'tool_use');
    });

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({
      name: 'ModelError',
      kind: 'unexpected',
    });
  });

  it('stops quietly when the request is cancelled', async () => {
    const api = await standIn((response) => {
      startStream(response);
      // The reply never finishes.
      writeEvents(response, replyEvents(['partial'], 'end_turn').slice(0, 3));
    });
    const controller = new AbortController();
    const events: ModelEvent[] = [];
    const request = {
      messages: [{ role: 'user', text: 'hi' }] as const,
      signal: controller.signal,
    };
    for await (const event of modelFor(api.url).stream(request)) {
      events.push(event);
      controller.abort();
    }

    expect(events).toEqual([{ type: 'text', text: 'partial' }]);
  });
});

describe('a failed request', () => {
  it.each([
    [401, 'authentication_error', 'authentication'],
    [402, 'billing_error', 'permission'],
    [403, 'permission_error', 'permission'],
    [404, 'not_found_error', 'not_found'],
    [400, 'invalid_request_error', 'invalid_request'],
    [413, 'request_too_large', 'invalid_request'],
    [408, 'request_timeout', 'connection'],
    [409, 'conflict', 'overloaded'],
    [429, 'rate_limit_error', 'rate_limit'],
    [500, 'api_error', 'overloaded'],
    [529, 'overloaded_error', 'overloaded'],
  ])('with status %i (%s) is reported as %s', async (status, type, kind) => {
    const api = await standIn((response) => {
      sendError(response, status, type);
    });

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({
      name: 'ModelError',
      kind,
      status,
    });
  });

  it('is retried when the provider is overloaded', async () => {
    const api = await standIn((response, _request, count) => {
      if (count === 1) {
        sendError(response, 529, 'overloaded_error');
      } else {
        sendReply(response, ['ok'], 'end_turn');
      }
    });

    const events = await collect(modelFor(api.url, { retries: 2 }));
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'end' });
    expect(api.requests).toHaveLength(2);
  });

  it('is not retried when the key is wrong', async () => {
    const api = await standIn((response) => {
      sendError(response, 401, 'authentication_error');
    });

    await expect(collect(modelFor(api.url, { retries: 2 }))).rejects.toMatchObject({
      kind: 'authentication',
    });
    expect(api.requests).toHaveLength(1);
  });

  it('that fails inside an open stream is reported by its error type', async () => {
    const api = await standIn((response) => {
      startStream(response);
      writeEvents(response, replyEvents(['partial'], 'end_turn').slice(0, 3));
      writeEvents(response, [
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ]);
      response.end();
    });

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({
      name: 'ModelError',
      kind: 'overloaded',
    });
  });

  it.each([
    ['authentication_error', 'authentication'],
    ['permission_error', 'permission'],
    ['invalid_request_error', 'invalid_request'],
    ['rate_limit_error', 'rate_limit'],
    ['api_error', 'overloaded'],
  ])('that fails inside an open stream with %s is reported as %s', async (type, kind) => {
    const api = await standIn((response) => {
      startStream(response);
      writeEvents(response, replyEvents(['partial'], 'end_turn').slice(0, 3));
      writeEvents(response, [{ type: 'error', error: { type, message: 'failed' } }]);
      response.end();
    });

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({ name: 'ModelError', kind });
  });

  it.each(['constructor', 'toString', '__proto__', 'no_such_type'])(
    'does not mistake the error type %s for a known one',
    async (type) => {
      const api = await standIn((response) => {
        sendError(response, 500, type);
      });

      await expect(collect(modelFor(api.url))).rejects.toMatchObject({
        name: 'ModelError',
        kind: 'overloaded',
      });
    },
  );

  it('keeps an unknown stop reason, which is server text, out of the error', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['x'], 'leaked test-key');
    });

    const failure = await collect(modelFor(api.url)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'ModelError', kind: 'unexpected' });
    expect(failure instanceof Error ? failure.message : 'test-key').not.toContain('test-key');
  });

  it('never carries a credential that the provider echoed back', async () => {
    // Built from pieces so that no credential-shaped text sits in this file.
    const token = ['sk', 'ant', 'abc123456789'].join('-');
    const echoed = `key test-key, token ${token}, header Bearer abcdefghijkl`;
    const api = await standIn((response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: echoed } }),
      );
    });

    const failure = await collect(modelFor(api.url)).catch((error: unknown) => error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('test-key');
    expect(message).not.toContain('abc123456789');
    expect(message).not.toContain('abcdefghijkl');
  });

  it('is logged by the core without the echoed credential', async () => {
    const api = await standIn((response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid key test-key' },
        }),
      );
    });
    const logged: string[] = [];
    let written = '';
    let answered: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      answered = resolve;
    });
    async function* input(): AsyncGenerator<string> {
      const initialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' } },
      };
      const create = { jsonrpc: '2.0', id: 90, method: 'conversation/create' };
      const chat = {
        jsonrpc: '2.0',
        id: 2,
        method: 'chat/send',
        params: { conversationId: 'c1', text: 'hi' },
      };
      yield JSON.stringify(initialize) + String.fromCharCode(10);
      yield JSON.stringify(create) + String.fromCharCode(10);
      yield JSON.stringify(chat) + String.fromCharCode(10);
      await done;
    }
    await serve({
      input: input(),
      write: (text) => {
        written += text;
        if (written.includes('"id":2')) {
          answered?.();
        }
      },
      model: modelFor(api.url),
      createConversationId: () => 'c1',
      info: { name: 'test-core', version: '0' },
      log: (text) => logged.push(text),
    });

    expect(written).toContain('"kind":"authentication"');
    expect(logged.join(' ')).toContain('authentication');
    expect(logged.join(' ')).not.toContain('test-key');
    expect(written).not.toContain('test-key');
  });

  it('with no server to reach is reported as a connection problem', async () => {
    const api = await standIn(() => undefined);
    await cleanups.pop()?.();

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({
      name: 'ModelError',
      kind: 'connection',
    });
  });
});

const STOP_REASON_BY_STOP = {
  end: 'end_turn',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
} as const;
const ERROR_TYPE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  429: 'rate_limit_error',
  500: 'api_error',
};

describeModelContract('Anthropic adapter', {
  apiKey: 'test-key',
  createModel: (url, retries) => modelFor(url, { retries }),
  respond(response: ServerResponse, behaviour: Behaviour): void {
    if ('reply' in behaviour) {
      sendReply(response, behaviour.reply, STOP_REASON_BY_STOP[behaviour.stop]);
    } else if ('stall' in behaviour) {
      startStream(response);
      writeEvents(response, replyEvents(behaviour.stall, 'end_turn').slice(0, -3));
    } else {
      const type = ERROR_TYPE_BY_STATUS[behaviour.status] ?? 'api_error';
      response.writeHead(behaviour.status, {
        'content-type': 'application/json',
        'retry-after-ms': '1',
      });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type, message: behaviour.message ?? 'stand-in failure' },
        }),
      );
    }
  },
});
