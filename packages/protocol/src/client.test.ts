import { describe, expect, it } from 'vitest';
import { ClientConnection, RpcError } from './client.js';
import { ErrorCode, type Message, type NotificationMessage, parseMessage } from './messages.js';

function connect() {
  const sent: Message[] = [];
  const notifications: NotificationMessage[] = [];
  const protocolErrors: number[] = [];
  const connection = new ClientConnection({
    write: (text) => {
      sent.push(parseMessage(text.trimEnd()));
    },
    onNotification: (notification) => notifications.push(notification),
    onProtocolError: (error) => protocolErrors.push(error.code),
  });
  const answer = (message: object): void => {
    connection.receive(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  return { connection, sent, notifications, protocolErrors, answer };
}

describe('ClientConnection', () => {
  it('sends a request and resolves with its result', async () => {
    const { connection, sent, answer } = connect();
    const result = connection.request('initialize', { protocolVersion: 1 });

    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
    ]);
    answer({ id: 1, result: { ok: true } });
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('leaves params out of a request that has none', () => {
    const { connection, sent } = connect();
    void connection.request('ping');

    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  });

  it('gives each request its own id and matches answers that arrive out of order', async () => {
    const { connection, answer } = connect();
    const first = connection.send('a');
    const second = connection.send('b');

    expect([first.id, second.id]).toEqual([1, 2]);
    answer({ id: 2, result: 'second' });
    answer({ id: 1, result: 'first' });
    await expect(first.response).resolves.toBe('first');
    await expect(second.response).resolves.toBe('second');
  });

  it('rejects with the code, message and data of an error answer', async () => {
    const { connection, answer } = connect();
    const result = connection.request('chat/send', { text: 'hi' });
    answer({ id: 1, error: { code: -32004, message: 'failed', data: { kind: 'rate_limit' } } });

    const failure = await result.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcError);
    expect(failure).toMatchObject({
      code: -32004,
      message: 'failed',
      data: { kind: 'rate_limit' },
    });
  });

  it('hands notifications on, also between the pieces of a split line', () => {
    const { connection, notifications } = connect();
    const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'chat/delta', params: { text: 'hi' } })}\n`;
    connection.receive(line.slice(0, 12));
    connection.receive(line.slice(12));

    expect(notifications).toEqual([
      { jsonrpc: '2.0', method: 'chat/delta', params: { text: 'hi' } },
    ]);
  });

  it('sends a notification without an id', () => {
    const { connection, sent } = connect();
    connection.notify('$/cancel', { id: 3 });

    expect(sent).toEqual([{ jsonrpc: '2.0', method: '$/cancel', params: { id: 3 } }]);
  });

  it('ignores an answer nobody is waiting for', () => {
    const { answer, protocolErrors } = connect();
    answer({ id: 99, result: 1 });

    expect(protocolErrors).toEqual([]);
  });

  it('reports text that is not a message and keeps working', async () => {
    const { connection, protocolErrors, answer } = connect();
    const result = connection.request('ping');
    connection.receive('not json\n');
    answer({ id: 1, result: 'pong' });

    expect(protocolErrors).toEqual([ErrorCode.ParseError]);
    await expect(result).resolves.toBe('pong');
  });

  it('answers a request from the other side with method not found', () => {
    const { sent, answer } = connect();
    answer({ id: 7, method: 'client/doSomething' });

    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 7,
        error: { code: ErrorCode.MethodNotFound, message: 'unknown method client/doSomething' },
      },
    ]);
  });

  it('rejects unanswered and later requests once it is closed', async () => {
    const { connection, sent } = connect();
    const waiting = connection.request('chat/send');
    connection.close(new Error('the core exited'));
    const late = connection.request('ping');
    connection.notify('$/cancel', { id: 1 });

    await expect(waiting).rejects.toThrow('the core exited');
    await expect(late).rejects.toThrow('the core exited');
    expect(sent).toHaveLength(1);
  });

  it('keeps working when a notification listener throws', async () => {
    const reported: unknown[] = [];
    const connection = new ClientConnection({
      write: () => undefined,
      onNotification: () => {
        throw new Error('listener failed');
      },
      onCallbackError: (error) => reported.push(error),
    });
    const result = connection.request('chat/send');
    const lines = [
      { jsonrpc: '2.0', method: 'chat/delta', params: { text: 'hi' } },
      { jsonrpc: '2.0', id: 1, result: { stopReason: 'end' } },
    ];
    // Both lines arrive in one chunk: the response must not be lost.
    connection.receive(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));

    await expect(result).resolves.toEqual({ stopReason: 'end' });
    expect(reported).toHaveLength(1);
  });

  it('keeps working when the error listeners throw too', async () => {
    const connection = new ClientConnection({
      write: () => undefined,
      onProtocolError: () => {
        throw new Error('listener failed');
      },
      onCallbackError: () => {
        throw new Error('reporter failed');
      },
    });
    const result = connection.request('ping');
    connection.receive('not json\n{"jsonrpc":"2.0","id":1,"result":"pong"}\n');

    await expect(result).resolves.toBe('pong');
  });

  it('rejects a request whose write fails', async () => {
    const connection = new ClientConnection({
      write: () => {
        throw new Error('pipe closed');
      },
    });

    await expect(connection.request('ping')).rejects.toThrow('pipe closed');
  });
});
