import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CoreErrorCode,
  type Message,
  PROTOCOL_VERSION,
  isNotification,
  isResponse,
  parseMessage,
} from '@icode/protocol';
import { describe, expect, it } from 'vitest';
import { standIn } from './testing/standIn.js';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/** A request as the test writes it. Only the id is needed to wait for its answer. */
interface Request {
  readonly id: number;
  readonly [field: string]: unknown;
}

/** A request that is written once the answers before it are known. */
type Step = Request | ((answers: readonly Message[]) => Request);

interface Run {
  readonly messages: Message[];
  readonly exitCode: number | null;
  readonly stderr: string;
}

/**
 * Starts the built core as a separate process and sends the requests one
 * after another, each once the one before has been answered. The connection
 * is closed after the last answer, as a client would do.
 */
function runCore(steps: readonly Step[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    // The SDKs print diagnostics when these are set. None of it may reach standard output.
    const env = { ...process.env, OPENAI_LOG: 'debug', ANTHROPIC_LOG: 'debug' };
    const child = spawn(process.execPath, [MAIN], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let next = 0;
    let current: Request | undefined;
    const completeLines = (): string[] => stdout.split('\n').slice(0, -1);
    const sendNext = (): void => {
      const step = steps[next];
      if (step === undefined) {
        current = undefined;
        child.stdin.end();
        return;
      }
      current =
        typeof step === 'function' ? step(completeLines().map((line) => parseMessage(line))) : step;
      child.stdin.write(`${JSON.stringify(current)}\n`);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const answer = `{"jsonrpc":"2.0","id":${String(current?.id)},`;
      if (current !== undefined && completeLines().some((line) => line.startsWith(answer))) {
        next += 1;
        sendNext();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      try {
        // Every line on standard output must be a protocol message.
        const messages = stdout
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => parseMessage(line));
        resolve({ messages, exitCode, stderr });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    sendNext();
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' } },
};
const CREATE = { jsonrpc: '2.0', id: 90, method: 'conversation/create' };

/** A chat request in the conversation that `CREATE` was answered with. */
const chat =
  (id: number, text = 'hello') =>
  (answers: readonly Message[]): Request => {
    const created = answers.find((message) => isResponse(message) && message.id === CREATE.id);
    const result = created !== undefined && 'result' in created ? created.result : undefined;
    const { conversationId } = result as { conversationId: string };
    return { jsonrpc: '2.0', id, method: 'chat/send', params: { conversationId, text } };
  };

describe('the core process', () => {
  it('reaches a model server chosen with model/set and streams its reply', async () => {
    const chunk = (delta: object, finish: string | null) => ({
      id: 'c',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stand-in-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const api = await standIn((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of [
        chunk({ content: 'Hello' }, null),
        chunk({ content: ' world' }, null),
        chunk({}, 'stop'),
      ]) {
        response.write(`data: ${JSON.stringify(part)}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
    const run = await runCore([
      INITIALIZE,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'model/set',
        params: {
          provider: 'openai-compatible',
          apiKey: 'test-key',
          model: 'some-model',
          baseUrl: api.url,
        },
      },
      CREATE,
      chat(3),
      chat(4, 'and again'),
    ]);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.messages[0]).toMatchObject({ id: 1, result: { protocolVersion: PROTOCOL_VERSION } });
    const reply = run.messages
      .filter(isNotification)
      .map((message) => (message.params as { text: string }).text)
      .join('');
    expect(reply).toBe('Hello worldHello world');
    expect(run.messages.at(-1)).toEqual({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end' } });
    // The second request carries the first turn, so the model can refer to it.
    expect(api.requests[1]?.body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hello world' },
      { role: 'user', content: 'and again' },
    ]);
    expect(api.requests[0]?.headers.authorization).toBe('Bearer test-key');
    expect(api.requests[0]?.body).toMatchObject({ model: 'some-model' });
  });

  it('refuses a chat request before a model is chosen, and a provider without its model name', async () => {
    const run = await runCore([
      INITIALIZE,
      CREATE,
      chat(2),
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'model/set',
        params: { provider: 'openai-compatible', apiKey: 'test-key' },
      },
    ]);
    const response = (id: number) =>
      run.messages.find((message) => isResponse(message) && message.id === id);

    expect(run.exitCode).toBe(0);
    expect(response(2)).toMatchObject({ error: { code: CoreErrorCode.ModelNotSet } });
    expect(response(3)).toMatchObject({
      error: { message: 'the openai-compatible provider needs a model name' },
    });
  });
});
