import { LineDecoder, encodeMessage } from './framing.js';
import {
  ErrorCode,
  type NotificationMessage,
  ProtocolError,
  type RequestId,
  isNotification,
  isRequest,
  parseMessage,
} from './messages.js';

/** An error answer from the other side. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** A request that has been sent and not yet answered. */
export interface SentRequest {
  /** The id to name in a cancel notification. */
  readonly id: RequestId;
  /** Resolves with the result, or rejects with an `RpcError` or the reason the connection closed. */
  readonly response: Promise<unknown>;
}

export interface ClientConnectionOptions {
  /** Sends text to the other side. */
  readonly write: (text: string) => void;
  /** Receives every notification from the other side. */
  readonly onNotification?: (notification: NotificationMessage) => void;
  /** Receives text from the other side that is not a valid message. */
  readonly onProtocolError?: (error: ProtocolError) => void;
}

/**
 * The client side of a connection: it sends requests and notifications,
 * matches each response to its request, and hands notifications on. It does
 * not own a process or a socket. The owner passes incoming text to `receive`
 * and calls `close` when the other side is gone.
 */
export class ClientConnection {
  readonly #options: ClientConnectionOptions;
  readonly #decoder = new LineDecoder();
  readonly #pending = new Map<
    RequestId,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  #nextId = 1;
  #closed: Error | undefined;

  constructor(options: ClientConnectionOptions) {
    this.#options = options;
  }

  /** Sends a request. Its answer arrives on the returned `response`. */
  send(method: string, params?: object): SentRequest {
    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      if (this.#closed !== undefined) {
        reject(this.#closed);
        return;
      }
      this.#pending.set(id, { resolve, reject });
      try {
        this.#options.write(
          encodeMessage({
            jsonrpc: '2.0',
            id,
            method,
            ...(params === undefined ? {} : { params }),
          }),
        );
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { id, response };
  }

  /** Sends a request and waits for its result. */
  request(method: string, params?: object): Promise<unknown> {
    return this.send(method, params).response;
  }

  /** Sends a notification, which has no answer. It is dropped when the connection is closed. */
  notify(method: string, params?: object): void {
    if (this.#closed !== undefined) {
      return;
    }
    this.#options.write(
      encodeMessage({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
    );
  }

  /** Takes text that arrived from the other side, in chunks of any size. */
  receive(chunk: string): void {
    for (const item of this.#decoder.push(chunk)) {
      if (item.ok) {
        this.#handleLine(item.line);
      } else {
        this.#options.onProtocolError?.(item.error);
      }
    }
  }

  /** Ends the connection. Every unanswered and every later request rejects with the reason. */
  close(reason: Error): void {
    if (this.#closed !== undefined) {
      return;
    }
    this.#closed = reason;
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of waiting) {
      request.reject(reason);
    }
  }

  #handleLine(line: string): void {
    let message;
    try {
      message = parseMessage(line);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.#options.onProtocolError?.(error);
        return;
      }
      throw error;
    }
    if (isNotification(message)) {
      this.#options.onNotification?.(message);
      return;
    }
    if (isRequest(message)) {
      // This side offers no methods, and a request must still get an answer.
      this.#options.write(
        encodeMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: ErrorCode.MethodNotFound, message: `unknown method ${message.method}` },
        }),
      );
      return;
    }
    const request = this.#pending.get(message.id);
    if (request === undefined) {
      // An answer to a request that is not waiting, for example after a restart.
      return;
    }
    this.#pending.delete(message.id);
    if ('error' in message) {
      request.reject(new RpcError(message.error.code, message.error.message, message.error.data));
    } else {
      request.resolve(message.result);
    }
  }
}
