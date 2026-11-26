import * as assert from 'node:assert/strict';
import { type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import type { TestCase } from './harness';

const EXTENSION_ID = 'najmulhasan-code.icode';

/** What the extension hands to its tests when VS Code runs it in test mode. */
interface TestApi {
  setApiKey(provider: string, apiKey: string): Promise<void>;
  sendMessage(text: string): Promise<{ readonly text: string; readonly stopReason: string }>;
  submitInChatView(text: string): Promise<{
    readonly text?: string;
    readonly stopReason?: string;
    readonly error?: string;
    /** What the page displayed for this message. */
    readonly shown?: string;
  }>;
}

interface SeenRequest {
  readonly authorization: string | undefined;
  readonly body: { readonly model?: string; readonly messages?: unknown };
}

/** A local server that stands in for an OpenAI-compatible model provider. */
async function startModelServer(respond: (response: ServerResponse) => void) {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(text) as SeenRequest['body'],
      });
      respond(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function streamReply(response: ServerResponse, pieces: readonly string[]): void {
  const chunk = (delta: object, finish: string | null) => ({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stand-in-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const piece of pieces) {
    response.write(`data: ${JSON.stringify(chunk({ content: piece }, null))}\n\n`);
  }
  response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function api(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi | undefined>(EXTENSION_ID);
  assert.ok(extension, 'the extension is not installed');
  const exported = await extension.activate();
  assert.ok(exported, 'the extension did not hand out its test interface');
  return exported;
}

/** Applies iCode settings for one test and restores the defaults afterwards. */
async function withSettings(
  settings: Readonly<Record<string, string>>,
  run: () => Promise<void>,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('icode');
  const target = vscode.ConfigurationTarget.Global;
  for (const [name, value] of Object.entries(settings)) {
    await config.update(name, value, target);
  }
  try {
    await run();
  } finally {
    for (const name of Object.keys(settings)) {
      await config.update(name, undefined, target);
    }
  }
}

export const engineTests: readonly TestCase[] = [
  {
    name: 'engine: a message reaches the model server and its reply streams back',
    async run() {
      const server = await startModelServer((response) => {
        streamReply(response, ['Hello', ' from', ' the model']);
      });
      try {
        const extension = await api();
        await extension.setApiKey('openai-compatible', 'e2e-test-key');
        await withSettings(
          { provider: 'openai-compatible', model: 'e2e-model', baseUrl: server.url },
          async () => {
            const reply = await extension.sendMessage('hello');

            assert.deepEqual(reply, { text: 'Hello from the model', stopReason: 'end' });
            assert.equal(server.requests.length, 1);
            const [request] = server.requests;
            assert.ok(request);
            assert.equal(request.authorization, 'Bearer e2e-test-key');
            assert.equal(request.body.model, 'e2e-model');
            assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hello' }]);

            // A second message reuses the running core and the model it was given.
            const second = await extension.sendMessage('again');
            assert.equal(second.text, 'Hello from the model');
            assert.equal(server.requests.length, 2);
          },
        );
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'engine: a second message is refused while a reply is still being written',
    async run() {
      // The server holds each reply back until the test releases it.
      const held: ServerResponse[] = [];
      const server = await startModelServer((response) => {
        held.push(response);
      });
      try {
        const extension = await api();
        await extension.setApiKey('openai-compatible', 'e2e-test-key');
        await withSettings(
          { provider: 'openai-compatible', model: 'e2e-model', baseUrl: server.url },
          async () => {
            const first = extension.sendMessage('first');
            await assert.rejects(extension.sendMessage('second'), /still being written/);
            while (held.length === 0) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            for (const response of held) {
              streamReply(response, ['done']);
            }

            assert.deepEqual(await first, { text: 'done', stopReason: 'end' });
            assert.equal(server.requests.length, 1);
          },
        );
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'chat panel: a message submitted in the panel is answered through the panel',
    async run() {
      const server = await startModelServer((response) => {
        streamReply(response, ['Hello', ' from', ' the panel']);
      });
      try {
        const extension = await api();
        await extension.setApiKey('openai-compatible', 'e2e-test-key');
        await vscode.commands.executeCommand('icode.chat.focus');
        await withSettings(
          { provider: 'openai-compatible', model: 'e2e-model', baseUrl: server.url },
          async () => {
            // The panel's own script receives the text, sends it to the
            // extension, and the reply is streamed back into the panel.
            const outcome = await extension.submitInChatView('hello from the panel');

            // `shown` is read back from the page, so the reply was really displayed.
            assert.deepEqual(outcome, {
              text: 'Hello from the panel',
              stopReason: 'end',
              shown: 'Hello from the panel',
            });
            assert.deepEqual(server.requests.at(-1)?.body.messages, [
              { role: 'user', content: 'hello from the panel' },
            ]);
          },
        );
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'chat panel: a failure is reported to the panel in plain words',
    async run() {
      const extension = await api();
      await vscode.commands.executeCommand('icode.chat.focus');
      await withSettings({ provider: 'anthropic' }, async () => {
        const outcome = await extension.submitInChatView('hello');

        assert.match(outcome.error ?? '', /No API key is set/);
        assert.match(outcome.shown ?? '', /No API key is set/);
      });
    },
  },
  {
    name: 'engine: a missing key is reported in plain words before anything is sent',
    async run() {
      const extension = await api();
      await withSettings({ provider: 'anthropic' }, async () => {
        await assert.rejects(extension.sendMessage('hello'), /No API key is set/);
      });
    },
  },
  {
    name: 'engine: a rejected key is reported in plain words, without the key',
    async run() {
      const server = await startModelServer((response) => {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad key e2e-test-key' } }));
      });
      try {
        const extension = await api();
        await extension.setApiKey('openai-compatible', 'e2e-test-key');
        await withSettings(
          { provider: 'openai-compatible', model: 'e2e-model', baseUrl: server.url },
          async () => {
            const failure = await extension.sendMessage('hello').catch((error: unknown) => error);
            assert.ok(failure instanceof Error);
            assert.match(failure.message, /rejected the API key/);
            assert.doesNotMatch(failure.message, /e2e-test-key/);
          },
        );
      } finally {
        await server.close();
      }
    },
  },
];
