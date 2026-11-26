/**
 * JSON-RPC 2.0 messages, as exchanged between the core and its clients.
 *
 * Batches are not part of the protocol. Each message is a single object.
 */

export const JSONRPC_VERSION = '2.0';

/**
 * Identifier that ties a response to its request. JSON-RPC permits null,
 * although a client should not choose it.
 */
export type RequestId = number | string | null;

export interface RequestMessage {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface NotificationMessage {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
}

export interface ErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface SuccessResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RequestId;
  readonly result: unknown;
}

export interface ErrorResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  /** Null when the request could not be read far enough to learn its id. */
  readonly id: RequestId;
  readonly error: ErrorObject;
}

export type ResponseMessage = SuccessResponse | ErrorResponse;
export type Message = RequestMessage | NotificationMessage | ResponseMessage;

/** Error codes defined by JSON-RPC 2.0. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** Thrown when incoming text is not a valid protocol message. */
export class ProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function invalid(reason: string): ProtocolError {
  return new ProtocolError(ErrorCode.InvalidRequest, reason);
}

/**
 * Parses one line of text into a message.
 *
 * @throws ProtocolError with `ParseError` when the text is not JSON, and with
 * `InvalidRequest` when the JSON is not a well-formed message.
 */
export function parseMessage(text: string): Message {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError(ErrorCode.ParseError, 'message is not valid JSON');
  }
  if (!isRecord(value)) {
    throw invalid('message is not an object');
  }
  if (value.jsonrpc !== JSONRPC_VERSION) {
    throw invalid('message does not declare JSON-RPC 2.0');
  }

  if ('method' in value) {
    if (typeof value.method !== 'string') {
      throw invalid('method is not a string');
    }
    if ('params' in value && (typeof value.params !== 'object' || value.params === null)) {
      throw invalid('params is neither an object nor an array');
    }
    if ('id' in value && !isRequestId(value.id)) {
      throw invalid('request id is not a string, a number or null');
    }
    return value as unknown as RequestMessage | NotificationMessage;
  }

  const hasResult = 'result' in value;
  const hasError = 'error' in value;
  if (hasResult === hasError) {
    throw invalid('message is neither a request nor a response');
  }
  if (!isRequestId(value.id)) {
    throw invalid('response id is not a string, a number or null');
  }
  if (hasResult) {
    return value as unknown as SuccessResponse;
  }
  const error = value.error;
  if (!isRecord(error) || !Number.isInteger(error.code) || typeof error.message !== 'string') {
    throw invalid('error is not an object with an integer code and a text message');
  }
  return value as unknown as ErrorResponse;
}

export function isRequest(message: Message): message is RequestMessage {
  return 'method' in message && 'id' in message;
}

export function isNotification(message: Message): message is NotificationMessage {
  return 'method' in message && !('id' in message);
}

export function isResponse(message: Message): message is ResponseMessage {
  return !('method' in message);
}
