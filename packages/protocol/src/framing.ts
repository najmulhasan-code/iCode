import { ErrorCode, type Message, ProtocolError } from './messages.js';

/**
 * Longest line the decoder accepts, in UTF-16 code units, not counting the
 * line break. A peer that sends more without a line break is not speaking the
 * protocol.
 */
export const MAX_LINE_LENGTH = 16 * 1024 * 1024;

/**
 * Serialises a message as one line of JSON followed by a line break.
 *
 * JSON text never contains a raw line break, so a line break always marks the
 * end of a message.
 */
export function encodeMessage(message: Message): string {
  return `${JSON.stringify(message)}\n`;
}

/** One item read from the stream: a complete line, or a line that was refused. */
export type DecodedLine =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly error: ProtocolError };

/**
 * Splits a stream of text into lines. Text arrives in chunks of any size, and
 * a line may span several chunks. A line ends with LF or CRLF.
 *
 * A line that is too long is reported once and then skipped up to its line
 * break, wherever the chunk boundaries fall. Lines before and after it are
 * returned as usual, so the stream stays usable.
 */
export class LineDecoder {
  readonly #maxLineLength: number;
  #pending = '';
  #skipping = false;

  constructor(maxLineLength: number = MAX_LINE_LENGTH) {
    this.#maxLineLength = maxLineLength;
  }

  /**
   * Adds a chunk and returns what it completed, in stream order. Blank lines
   * are skipped.
   */
  push(chunk: string): DecodedLine[] {
    const data = this.#pending + chunk;
    this.#pending = '';
    const decoded: DecodedLine[] = [];
    let start = 0;
    for (;;) {
      const end = data.indexOf('\n', start);
      if (end === -1) {
        break;
      }
      if (this.#skipping) {
        // The line break that ends the oversized line.
        this.#skipping = false;
      } else {
        const line = data.slice(start, end).replace(/\r$/, '');
        if (line.length > this.#maxLineLength) {
          decoded.push(tooLong());
        } else if (line !== '') {
          decoded.push({ ok: true, line });
        }
      }
      start = end + 1;
    }

    const rest = data.slice(start);
    if (this.#skipping) {
      return decoded;
    }
    // A trailing CR may be the first half of a CRLF line break.
    const length = rest.endsWith('\r') ? rest.length - 1 : rest.length;
    if (length > this.#maxLineLength) {
      decoded.push(tooLong());
      this.#skipping = true;
    } else {
      this.#pending = rest;
    }
    return decoded;
  }
}

function tooLong(): DecodedLine {
  return {
    ok: false,
    error: new ProtocolError(ErrorCode.ParseError, 'message line is too long'),
  };
}
