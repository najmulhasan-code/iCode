import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Model, ModelEvent } from './model.js';
import { createOpenAICompatibleModel } from './openai.js';
import { type Behaviour, describeModelContract } from './testing/modelContract.js';
import { standIn } from './testing/standIn.js';

type Chunk = Record<string, unknown>;

function startStream(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
}

function writeChunks(response: ServerResponse, chunks: readonly Chunk[]): void {
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
}

function finishStream(response: ServerResponse): void {
  response.write('data: [DONE]\n\n');
  response.end();
}

const base = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'stand-in-model',
};

const textChunk = (content: string): Chunk => ({
  ...base,
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});
const finishChunk = (reason: string): Chunk => ({
  ...base,
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
});
const usageChunk: Chunk = {
  ...base,
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
};

function sendReply(response: ServerResponse, pieces: readonly string[], finish: string): void {
  startStream(response);
  writeChunks(response, [...pieces.map(textChunk), finishChunk(finish), usageChunk]);
  finishStream(response);
}

function sendError(
  response: ServerResponse,
  status: number,
  error: { message?: string; type?: string; code?: string },
): void {
  response.writeHead(status, { 'content-type': 'application/json', 'retry-after-ms': '1' });
  response.end(JSON.stringify({ error: { message: 'stand-in failure', ...error } }));
}

async function collect(model: Model): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  const request = {
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }] as const,
    signal: new AbortController().signal,
  };
  for await (const event of model.stream(request)) {
    events.push(event);
  }
  return events;
}

const modelFor = (url: string, retries = 0): Model =>
  createOpenAICompatibleModel({
    apiKey: 'test-key',
    model: 'some-model',
    baseURL: url,
    maxRetries: retries,
  });

const FINISH_BY_STOP = { end: 'stop', max_tokens: 'length', refusal: 'content_filter' } as const;

describeModelContract('OpenAI-compatible adapter', {
  apiKey: 'test-key',
  createModel: modelFor,
  respond(response: ServerResponse, behaviour: Behaviour): void {
    if ('reply' in behaviour) {
      sendReply(response, behaviour.reply, FINISH_BY_STOP[behaviour.stop]);
    } else if ('stall' in behaviour) {
      startStream(response);
      writeChunks(response, behaviour.stall.map(textChunk));
    } else {
      sendError(
        response,
        behaviour.status,
        behaviour.message === undefined ? {} : { message: behaviour.message },
      );
    }
  },
});

describe('OpenAI-compatible adapter', () => {
  it('sends the key, the model, the conversation and asks for usage', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['ok'], 'stop');
    });
    await collect(modelFor(api.url));

    const [request] = api.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/chat/completions');
    expect(request?.headers.authorization).toBe('Bearer test-key');
    expect(request?.body).toMatchObject({
      model: 'some-model',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('reports the tokens used and the model that answered', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['ok'], 'stop');
    });

    expect((await collect(modelFor(api.url))).at(-1)).toEqual({
      type: 'end',
      reason: 'end',
      usage: { inputTokens: 12, outputTokens: 7 },
      model: 'stand-in-model',
    });
  });

  it('leaves the usage out when the server does not report it', async () => {
    const api = await standIn((response) => {
      startStream(response);
      writeChunks(response, [textChunk('ok'), finishChunk('stop')]);
      finishStream(response);
    });

    const end = (await collect(modelFor(api.url))).at(-1);
    expect(end).toMatchObject({ type: 'end', reason: 'end' });
    expect(end).not.toHaveProperty('usage');
  });

  it('skips chunks that carry no text', async () => {
    const api = await standIn((response) => {
      startStream(response);
      writeChunks(response, [
        { ...base, choices: [] },
        { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        textChunk(''),
        { ...base, choices: [{ index: 0, delta: null, finish_reason: null }] },
        textChunk('answer'),
        finishChunk('stop'),
      ]);
      finishStream(response);
    });

    const texts = (await collect(modelFor(api.url))).filter((event) => event.type === 'text');
    expect(texts).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('reports a reply that was cut off before a finish reason as a failure', async () => {
    const api = await standIn((response) => {
      startStream(response);
      writeChunks(response, [textChunk('partial')]);
      finishStream(response);
    });

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({
      name: 'ModelError',
      kind: 'unexpected',
    });
  });

  it('reports a reply that stops to call a tool as a failure, because no tools were offered', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['x'], 'tool_calls');
    });

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it('reports an exhausted quota as a permission problem and does not retry it away', async () => {
    const api = await standIn((response) => {
      sendError(response, 429, { type: 'insufficient_quota', code: 'insufficient_quota' });
    });

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({
      name: 'ModelError',
      kind: 'permission',
      status: 429,
    });
  });

  it('shows a refusal written to its own field and reports the reply as refused', async () => {
    const api = await standIn((response) => {
      startStream(response);
      writeChunks(response, [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { refusal: 'I cannot ' }, finish_reason: null }] },
        {
          ...base,
          choices: [{ index: 0, delta: { refusal: 'help with that.' }, finish_reason: null }],
        },
        finishChunk('stop'),
      ]);
      finishStream(response);
    });

    expect(await collect(modelFor(api.url))).toEqual([
      { type: 'text', text: 'I cannot ' },
      { type: 'text', text: 'help with that.' },
      { type: 'end', reason: 'refusal', model: 'stand-in-model' },
    ]);
  });

  it('keeps an unexpected finish reason, which is server text, out of the error', async () => {
    const api = await standIn((response) => {
      sendReply(response, ['x'], 'leaked test-key');
    });

    const failure = await collect(modelFor(api.url)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'ModelError', kind: 'unexpected' });
    expect(failure instanceof Error ? failure.message : 'test-key').not.toContain('test-key');
  });

  it('leaves out the usage option when it is switched off', async () => {
    const api = await standIn((response, request) => {
      if ('stream_options' in request.body) {
        sendError(response, 400, { type: 'invalid_request_error' });
      } else {
        startStream(response);
        writeChunks(response, [textChunk('ok'), finishChunk('stop')]);
        finishStream(response);
      }
    });
    const strict = createOpenAICompatibleModel({
      apiKey: 'test-key',
      model: 'some-model',
      baseURL: api.url,
      maxRetries: 0,
      reportUsage: false,
    });

    expect((await collect(strict)).at(-1)).toMatchObject({ type: 'end', reason: 'end' });
    expect(api.requests[0]?.body).not.toHaveProperty('stream_options');
    await expect(collect(modelFor(api.url))).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it.each(['constructor', 'toString', '__proto__', 'no_such_code'])(
    'does not mistake the error code %s for a known one',
    async (code) => {
      const api = await standIn((response) => {
        sendError(response, 500, { type: code, code });
      });

      await expect(collect(modelFor(api.url))).rejects.toMatchObject({
        name: 'ModelError',
        kind: 'overloaded',
      });
    },
  );

  it('reports an error sent inside an open stream', async () => {
    const api = await standIn((response) => {
      startStream(response);
      writeChunks(response, [
        textChunk('partial'),
        { error: { message: 'boom', type: 'server_error', code: 'server_error' } },
      ]);
      finishStream(response);
    });

    await expect(collect(modelFor(api.url))).rejects.toMatchObject({
      name: 'ModelError',
      kind: 'overloaded',
    });
  });
});
