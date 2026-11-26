import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type Message, PROTOCOL_VERSION, isNotification, parseMessage } from '@icode/protocol';
import { describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

interface Run {
  readonly messages: Message[];
  readonly exitCode: number | null;
  readonly stderr: string;
}

/**
 * Starts the built core as a separate process, sends the lines, and collects
 * its output. The connection is closed once the core has answered the request
 * with the given id, as a client would do.
 */
function runCore(lines: readonly unknown[], lastId: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], { stdio: ['pipe', 'pipe', 'pipe'] });
    const answer = `{"jsonrpc":"2.0","id":${String(lastId)},`;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.split('\n').some((line) => line.startsWith(answer))) {
        child.stdin.end();
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
    for (const line of lines) {
      child.stdin.write(`${JSON.stringify(line)}\n`);
    }
  });
}

describe('the core process', () => {
  it('completes the handshake and a chat request over standard input and output', async () => {
    const requests = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' } },
      },
      { jsonrpc: '2.0', id: 2, method: 'chat/send', params: { text: 'hello' } },
    ];
    const run = await runCore(requests, 2);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.messages[0]).toMatchObject({ id: 1, result: { protocolVersion: PROTOCOL_VERSION } });
    const reply = run.messages
      .filter(isNotification)
      .map((message) => (message.params as { text: string }).text)
      .join('');
    expect(reply).toBe('The core is running. No model provider is connected yet.');
    expect(run.messages.at(-1)).toEqual({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end' } });
  });
});
