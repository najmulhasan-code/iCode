import type { RequestId } from './messages.js';

/** Request: send one user message to the model and stream the reply. */
export const CHAT_SEND_METHOD = 'chat/send';

/** Notification from the core: the next piece of the reply to a chat request. */
export const CHAT_DELTA_METHOD = 'chat/delta';

/** Notification from a client: stop the request with the given id. */
export const CANCEL_METHOD = '$/cancel';

export interface ChatSendParams {
  readonly text: string;
}

/**
 * Why a reply ended: the model finished, the model reached its output limit,
 * or the request was cancelled.
 */
export type StopReason = 'end' | 'max_tokens' | 'cancelled';

export interface ChatSendResult {
  readonly stopReason: StopReason;
}

export interface ChatDeltaParams {
  /** Id of the chat request this piece belongs to. */
  readonly requestId: RequestId;
  readonly text: string;
}

export interface CancelParams {
  readonly id: RequestId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isChatSendParams(value: unknown): value is ChatSendParams {
  return isRecord(value) && typeof value.text === 'string';
}

export function isCancelParams(value: unknown): value is CancelParams {
  if (!isRecord(value) || !('id' in value)) {
    return false;
  }
  const id = value.id;
  return id === null || typeof id === 'string' || typeof id === 'number';
}

/**
 * Error codes the core uses in addition to the JSON-RPC ones. They lie in the
 * range JSON-RPC reserves for implementation-defined server errors.
 */
export const CoreErrorCode = {
  NotInitialized: -32000,
  UnsupportedVersion: -32001,
  AlreadyInitialized: -32002,
  RequestInProgress: -32003,
} as const;
