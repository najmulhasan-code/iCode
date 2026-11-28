import type { RequestId } from './messages.js';

/** Request: start a new, empty conversation. The core answers with its id. */
export const CONVERSATION_CREATE_METHOD = 'conversation/create';

/**
 * Request: add one user message to a conversation, send the conversation to
 * the model and stream the reply.
 */
export const CHAT_SEND_METHOD = 'chat/send';

/** Notification from the core: the next piece of the reply to a chat request. */
export const CHAT_DELTA_METHOD = 'chat/delta';

/** Notification from a client: stop the request with the given id. */
export const CANCEL_METHOD = '$/cancel';

export interface ConversationCreateResult {
  /** Names the conversation in later requests on this connection. */
  readonly conversationId: string;
}

export interface ChatSendParams {
  readonly conversationId: string;
  /** The message from the user. It must contain more than white space. */
  readonly text: string;
}

/**
 * Why a reply ended: the model finished, the model reached its output limit,
 * the provider's safety system declined the request, or the request was
 * cancelled.
 */
export type StopReason = 'end' | 'max_tokens' | 'refusal' | 'cancelled';

/**
 * Tokens one model request consumed, as the provider counted them. The core
 * never estimates these numbers. When the provider continued a declined
 * request on another model, they are the counts of the attempt that wrote the
 * reply, so they are not the whole cost of the request.
 */
export interface TokenUsage {
  /** All input the request carried, including what was read from or written to the cache. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The part of the input read from the provider's cache, when it says. */
  readonly cacheReadTokens?: number;
  /** The part of the input written to the provider's cache, when it says. */
  readonly cacheWriteTokens?: number;
}

/**
 * About how full a conversation is after a reply. It is the sum of what the
 * provider counted for the last request and its reply. The next request
 * starts from about there, but it is an estimate and no guarantee: a provider
 * may not send all of a reply's thinking back.
 */
export interface ContextSize {
  readonly usedTokens: number;
  /** The most input the model accepts in one request, when its provider says. */
  readonly limitTokens?: number;
}

export interface ChatSendResult {
  readonly stopReason: StopReason;
  /**
   * Left out when the counts are unknown; after a reply that was stopped,
   * declined or not kept, because what the conversation holds was then never
   * counted; and after a reply written by another model than the one asked
   * for, whose counts and limit differ.
   */
  readonly context?: ContextSize;
  /**
   * Left out when the provider reported no counts that can be trusted. A
   * stopped reply has them only if the provider had sent them before the stop.
   */
  readonly usage?: TokenUsage;
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
  return (
    isRecord(value) &&
    typeof value.conversationId === 'string' &&
    typeof value.text === 'string' &&
    value.text.trim() !== ''
  );
}

export function isConversationCreateResult(value: unknown): value is ConversationCreateResult {
  return isRecord(value) && typeof value.conversationId === 'string';
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
  /** The model provider could not be reached or refused the request. */
  ModelRequestFailed: -32004,
  /** A chat request arrived before any model was chosen. */
  ModelNotSet: -32005,
  /** A request named a conversation this connection does not have. */
  UnknownConversation: -32006,
  /** A message arrived for a conversation whose last reply has not ended. */
  ConversationBusy: -32007,
} as const;

/** Carried in the `data` of a `ModelRequestFailed` error. */
export interface ModelRequestFailedData {
  /**
   * The kind of failure, for example `authentication` or `rate_limit`.
   * `context_overflow` means the conversation is longer than the model accepts.
   */
  readonly kind: string;
}
