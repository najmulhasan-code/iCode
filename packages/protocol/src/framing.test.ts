import { describe, expect, it } from 'vitest';
import { type DecodedLine, LineDecoder, MAX_LINE_LENGTH, encodeMessage } from './framing.js';
import { ErrorCode, parseMessage } from './messages.js';

/** Lines as text, with a refused line shown as the marker "<too long>". */
function show(decoded: DecodedLine[]): string[] {
  return decoded.map((item) => {
    if (item.ok) {
      return item.line;
    }
    expect(item.error.code).toBe(ErrorCode.ParseError);
    return '<too long>';
  });
}

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
    const [line] = show(new LineDecoder().push(encodeMessage(message)));
    expect(parseMessage(line ?? '')).toEqual(message);
  });
});

describe('LineDecoder', () => {
  it('returns nothing until a line is complete', () => {
    const decoder = new LineDecoder();
    expect(show(decoder.push('{"a":'))).toEqual([]);
    expect(show(decoder.push('1}'))).toEqual([]);
    expect(show(decoder.push('\n'))).toEqual(['{"a":1}']);
  });

  it('returns several lines from one chunk and keeps the unfinished rest', () => {
    const decoder = new LineDecoder();
    expect(show(decoder.push('one\ntwo\nthr'))).toEqual(['one', 'two']);
    expect(show(decoder.push('ee\n'))).toEqual(['three']);
  });

  it('accepts Windows line endings and skips blank lines', () => {
    expect(show(new LineDecoder().push('one\r\n\r\n\ntwo\r\n'))).toEqual(['one', 'two']);
  });

  it('keeps a character that is split across two chunks', () => {
    const decoder = new LineDecoder();
    const [high, low] = '😀';
    expect(show(decoder.push(`a${high ?? ''}`))).toEqual([]);
    expect(show(decoder.push(`${low ?? ''}b\n`))).toEqual(['a😀b']);
  });

  it('applies the limit to the line without its line break', () => {
    expect(show(new LineDecoder(4).push('1234\n'))).toEqual(['1234']);
    expect(show(new LineDecoder(4).push('1234\r\n'))).toEqual(['1234']);
    expect(show(new LineDecoder(4).push('12345\n'))).toEqual(['<too long>']);
    expect(show(new LineDecoder(4).push('12345\r\n'))).toEqual(['<too long>']);
  });

  it('accepts a line at the limit whose CRLF is split across chunks', () => {
    const decoder = new LineDecoder(4);
    expect(show(decoder.push('1234\r'))).toEqual([]);
    expect(show(decoder.push('\n'))).toEqual(['1234']);
  });

  it('accepts a line of exactly the default limit with either line ending', () => {
    const payload = 'x'.repeat(MAX_LINE_LENGTH);
    expect(new LineDecoder().push(`${payload}\n`)).toEqual([{ ok: true, line: payload }]);
    expect(new LineDecoder().push(`${payload}\r\n`)).toEqual([{ ok: true, line: payload }]);
  });

  it('returns the lines before and after a line that is too long', () => {
    expect(show(new LineDecoder(4).push('ok\n12345\nyes\n'))).toEqual(['ok', '<too long>', 'yes']);
  });

  it('skips the rest of an oversized line that arrives in later chunks', () => {
    const decoder = new LineDecoder(4);
    expect(show(decoder.push('12345'))).toEqual(['<too long>']);
    expect(show(decoder.push('678'))).toEqual([]);
    expect(show(decoder.push('ok\n'))).toEqual([]);
    expect(show(decoder.push('next\n'))).toEqual(['next']);
  });

  it('reports an oversized line once and still returns a line completed before it', () => {
    const decoder = new LineDecoder(4);
    expect(show(decoder.push('ok\n12345'))).toEqual(['ok', '<too long>']);
    expect(show(decoder.push('6\nyes\n'))).toEqual(['yes']);
  });
});
