import { ErrorCode, type Message, ProtocolError } from './messages.js';

/**
 * Longest line the decoder accepts, in UTF-16 code units. A peer that sends
 * more without a line break is not speaking the protocol.
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

/**
 * Splits a stream of text into lines. Text arrives in chunks of any size, and
 * a line may span several chunks.
 */
export class LineDecoder {
  readonly #maxLineLength: number;
  #pending = '';

  constructor(maxLineLength: number = MAX_LINE_LENGTH) {
    this.#maxLineLength = maxLineLength;
  }

  /**
   * Adds a chunk and returns the lines it completed, without their line
   * breaks. Blank lines are skipped.
   *
   * @throws ProtocolError when a line grows past the maximum length.
   */
  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const end = this.#pending.indexOf('\n', start);
      if (end === -1) {
        break;
      }
      this.#checkLength(end - start);
      const line = this.#pending.slice(start, end).replace(/\r$/, '');
      if (line !== '') {
        lines.push(line);
      }
      start = end + 1;
    }
    this.#pending = this.#pending.slice(start);
    this.#checkLength(this.#pending.length);
    return lines;
  }

  #checkLength(length: number): void {
    if (length > this.#maxLineLength) {
      this.#pending = '';
      throw new ProtocolError(ErrorCode.ParseError, 'message line is too long');
    }
  }
}
