import { describe, expect, it } from 'vitest';
import { LineDecoder, encodeMessage } from './framing.js';
import { ProtocolError, parseMessage } from './messages.js';

describe('encodeMessage', () => {
  it('writes one line that ends with a line break', () => {
    const text = encodeMessage({ jsonrpc: '2.0', method: 'chat/delta', params: { text: 'a\nb' } });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).not.toContain('\n');
  });

  it('round-trips through the decoder and the parser', () => {
    const message = {
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: { text: 'é\n😀' },
    } as const;
    const [line] = new LineDecoder().push(encodeMessage(message));
    expect(line).toBeDefined();
    expect(parseMessage(line ?? '')).toEqual(message);
  });
});

describe('LineDecoder', () => {
  it('returns nothing until a line is complete', () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push('1}')).toEqual([]);
    expect(decoder.push('\n')).toEqual(['{"a":1}']);
  });

  it('returns several lines from one chunk and keeps the unfinished rest', () => {
    const decoder = new LineDecoder();
    expect(decoder.push('one\ntwo\nthr')).toEqual(['one', 'two']);
    expect(decoder.push('ee\n')).toEqual(['three']);
  });

  it('accepts Windows line endings and skips blank lines', () => {
    expect(new LineDecoder().push('one\r\n\r\n\ntwo\r\n')).toEqual(['one', 'two']);
  });

  it('rejects a complete line that is too long', () => {
    expect(() => new LineDecoder(4).push('12345\n')).toThrow(ProtocolError);
  });

  it('rejects an unfinished line that is too long', () => {
    expect(() => new LineDecoder(4).push('12345')).toThrow(ProtocolError);
  });

  it('continues with the next line after rejecting one', () => {
    const decoder = new LineDecoder(4);
    expect(() => decoder.push('12345')).toThrow(ProtocolError);
    expect(decoder.push('ok\n')).toEqual(['ok']);
  });
});
