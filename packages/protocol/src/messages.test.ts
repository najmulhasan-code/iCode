import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  ProtocolError,
  isNotification,
  isRequest,
  isResponse,
  parseMessage,
} from './messages.js';

function codeOf(text: string): number | undefined {
  try {
    parseMessage(text);
  } catch (error) {
    if (error instanceof ProtocolError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

describe('parseMessage', () => {
  it('reads a request', () => {
    const message = parseMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    expect(isRequest(message)).toBe(true);
    expect(isNotification(message)).toBe(false);
    expect(isResponse(message)).toBe(false);
  });

  it('reads a request with a string id and no params', () => {
    expect(isRequest(parseMessage('{"jsonrpc":"2.0","id":"a","method":"ping"}'))).toBe(true);
  });

  it('reads a notification', () => {
    const message = parseMessage('{"jsonrpc":"2.0","method":"chat/delta","params":{"text":"hi"}}');
    expect(isNotification(message)).toBe(true);
    expect(isRequest(message)).toBe(false);
  });

  it('reads a request and a success response whose id is null', () => {
    const request = parseMessage('{"jsonrpc":"2.0","id":null,"method":"ping"}');
    expect(isRequest(request)).toBe(true);
    expect(isNotification(request)).toBe(false);
    expect(isResponse(parseMessage('{"jsonrpc":"2.0","id":null,"result":1}'))).toBe(true);
  });

  it('reads a success response, including a null result', () => {
    expect(isResponse(parseMessage('{"jsonrpc":"2.0","id":1,"result":null}'))).toBe(true);
  });

  it('reads an error response, including one with a null id', () => {
    const text = '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"bad"}}';
    expect(isResponse(parseMessage(text))).toBe(true);
  });

  it('rejects text that is not JSON', () => {
    expect(codeOf('{not json')).toBe(ErrorCode.ParseError);
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"hello"'],
    ['a missing version', '{"id":1,"method":"m"}'],
    ['a wrong version', '{"jsonrpc":"1.0","id":1,"method":"m"}'],
    ['a method that is not text', '{"jsonrpc":"2.0","id":1,"method":5}'],
    ['params that are not structured', '{"jsonrpc":"2.0","id":1,"method":"m","params":3}'],
    ['a request id that is an object', '{"jsonrpc":"2.0","id":{},"method":"m"}'],
    ['a request id that overflows', '{"jsonrpc":"2.0","id":1e400,"method":"m"}'],
    ['neither a method nor a result', '{"jsonrpc":"2.0","id":1}'],
    [
      'both a result and an error',
      '{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"x"}}',
    ],
    ['a response without an id', '{"jsonrpc":"2.0","result":1}'],
    [
      'an error with a fractional code',
      '{"jsonrpc":"2.0","id":1,"error":{"code":1.5,"message":"x"}}',
    ],
    [
      'an error with an overflowing code',
      '{"jsonrpc":"2.0","id":1,"error":{"code":1e400,"message":"x"}}',
    ],
    ['an error without a code', '{"jsonrpc":"2.0","id":1,"error":{"message":"x"}}'],
    ['an error that is not an object', '{"jsonrpc":"2.0","id":1,"error":"x"}'],
  ])('rejects %s', (_name, text) => {
    expect(codeOf(text)).toBe(ErrorCode.InvalidRequest);
  });
});
