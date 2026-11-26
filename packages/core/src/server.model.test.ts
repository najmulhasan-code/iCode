import {
  CoreErrorCode,
  ErrorCode,
  type Message,
  PROTOCOL_VERSION,
  type SetModelParams,
  isNotification,
  isResponse,
  parseMessage,
} from '@icode/protocol';
import { describe, expect, it } from 'vitest';
import { createFixedModel } from './fixedModel.js';
import { type Model, ModelConfigError } from './model.js';
import { type ServerOptions, serve } from './server.js';

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' } },
};
const CREATE = { jsonrpc: '2.0', id: 90, method: 'conversation/create' };
const chat = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'chat/send',
  params: { conversationId: 'c1', text: 'hi' },
});
const setModel = (id: number, params: unknown) => ({
  jsonrpc: '2.0',
  id,
  method: 'model/set',
  params,
});
const KEY = 'the-test-credential';

/**
 * Sends the requests one after another, each once the one before has been
 * answered, then disconnects.
 */
async function exchange(
  options: Pick<ServerOptions, 'model' | 'createModel'>,
  requests: readonly { readonly id: number; readonly [field: string]: unknown }[],
) {
  const received: Message[] = [];
  const logged: string[] = [];
  let written = '';
  let wake: (() => void) | undefined;
  const answered = (id: number) =>
    received.some((message) => isResponse(message) && message.id === id);

  async function* input(): AsyncGenerator<string> {
    for (const request of requests) {
      yield `${JSON.stringify(request)}\n`;
      while (!answered(request.id)) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  }
  await serve({
    ...options,
    input: input(),
    createConversationId: () => 'c1',
    write: (text) => {
      written += text;
      for (const line of text.split('\n')) {
        if (line !== '') {
          received.push(parseMessage(line));
        }
      }
      wake?.();
    },
    info: { name: 'test-core', version: '0' },
    log: (text) => logged.push(text),
  });
  return {
    written,
    logged,
    response: (id: number) => received.find((message) => isResponse(message) && message.id === id),
    reply: () =>
      received
        .filter(isNotification)
        .map((message) => (message.params as { text: string }).text)
        .join(''),
  };
}

/** A factory that records what it was asked for and answers with the provider's name. */
function recordingFactory() {
  const calls: SetModelParams[] = [];
  const createModel = (params: SetModelParams): Model => {
    calls.push(params);
    return createFixedModel([`reply from ${params.provider}`]);
  };
  return { calls, createModel };
}

describe('model/set', () => {
  it('chooses the model that later chat requests use', async () => {
    const factory = recordingFactory();
    const params = { provider: 'anthropic', apiKey: KEY, model: 'some-model' };
    const run = await exchange(factory, [INITIALIZE, CREATE, setModel(2, params), chat(3)]);

    expect(run.response(2)).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(factory.calls).toEqual([params]);
    expect(run.reply()).toBe('reply from anthropic');
    expect(run.response(3)).toMatchObject({ result: { stopReason: 'end' } });
  });

  it('can be sent again to switch to another model', async () => {
    const factory = recordingFactory();
    const run = await exchange(factory, [
      INITIALIZE,
      CREATE,
      setModel(2, { provider: 'anthropic', apiKey: KEY }),
      chat(3),
      setModel(4, { provider: 'openai-compatible', apiKey: KEY, model: 'm' }),
      chat(5),
    ]);

    expect(run.reply()).toBe('reply from anthropicreply from openai-compatible');
  });

  it.each([
    ['no key', { provider: 'anthropic' }],
    ['an empty key', { provider: 'anthropic', apiKey: '' }],
    ['an unknown provider', { provider: 'someone-else', apiKey: KEY }],
    ['a model that is not text', { provider: 'anthropic', apiKey: KEY, model: 5 }],
    ['an empty address', { provider: 'anthropic', apiKey: KEY, baseUrl: '' }],
    ['no params', undefined],
  ])('refuses %s', async (_name, params) => {
    const factory = recordingFactory();
    const run = await exchange(factory, [INITIALIZE, setModel(2, params)]);

    expect(run.response(2)).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
    expect(factory.calls).toHaveLength(0);
  });

  it('passes on the reason when the parameters do not fit the provider', async () => {
    const createModel = (): Model => {
      throw new ModelConfigError('this provider needs a model name');
    };
    const run = await exchange({ createModel }, [
      INITIALIZE,
      setModel(2, { provider: 'openai-compatible', apiKey: KEY }),
    ]);

    expect(run.response(2)).toMatchObject({
      error: { code: ErrorCode.InvalidParams, message: 'this provider needs a model name' },
    });
  });

  it.each([
    ['an error', (params: unknown) => new Error(JSON.stringify(params))],
    ['a string', (params: unknown) => JSON.stringify(params)],
  ])(
    'hides an unexpected failure thrown as %s, which may hold the key',
    async (_name, toThrown) => {
      const createModel = (params: unknown): Model => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw toThrown(params);
      };
      const run = await exchange({ createModel }, [
        INITIALIZE,
        setModel(2, { provider: 'anthropic', apiKey: KEY }),
      ]);

      expect(run.response(2)).toMatchObject({
        error: { code: ErrorCode.InternalError, message: 'the model could not be set up' },
      });
      expect(run.written).not.toContain(KEY);
      expect(run.logged.join(' ')).not.toContain(KEY);
    },
  );

  it('is not offered when the core was started without a way to build models', async () => {
    const run = await exchange({ model: createFixedModel(['x']) }, [
      INITIALIZE,
      setModel(2, { provider: 'anthropic', apiKey: KEY }),
    ]);

    expect(run.response(2)).toMatchObject({ error: { code: ErrorCode.MethodNotFound } });
  });

  it('is refused before initialize', async () => {
    const factory = recordingFactory();
    const run = await exchange(factory, [setModel(1, { provider: 'anthropic', apiKey: KEY })]);

    expect(run.response(1)).toMatchObject({ error: { code: CoreErrorCode.NotInitialized } });
    expect(factory.calls).toHaveLength(0);
  });

  it('never writes the key to the client or to the log', async () => {
    const factory = recordingFactory();
    const run = await exchange(factory, [
      INITIALIZE,
      setModel(2, { provider: 'anthropic', apiKey: KEY }),
      setModel(3, { provider: 'nobody', apiKey: KEY }),
      CREATE,
      chat(4),
    ]);

    expect(run.written).not.toContain(KEY);
    expect(run.logged.join(' ')).not.toContain(KEY);
  });
});

describe('chat/send', () => {
  it('is refused until a model has been chosen', async () => {
    const run = await exchange(recordingFactory(), [INITIALIZE, CREATE, chat(2)]);

    expect(run.response(2)).toMatchObject({ error: { code: CoreErrorCode.ModelNotSet } });
  });
});
