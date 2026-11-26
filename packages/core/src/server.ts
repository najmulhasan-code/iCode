import {
  CANCEL_METHOD,
  CHAT_DELTA_METHOD,
  CHAT_SEND_METHOD,
  type ChatDeltaParams,
  type ChatSendResult,
  CoreErrorCode,
  ErrorCode,
  INITIALIZE_METHOD,
  type InitializeResult,
  LineDecoder,
  type Message,
  type NotificationMessage,
  PROTOCOL_VERSION,
  type PeerInfo,
  ProtocolError,
  type RequestId,
  type RequestMessage,
  encodeMessage,
  isCancelParams,
  isChatSendParams,
  isInitializeParams,
  isNotification,
  isRequest,
  isSupportedVersion,
  parseMessage,
} from '@icode/protocol';
import type { Model } from './model.js';

export interface ServerOptions {
  /** Text from the client, in chunks of any size. */
  readonly input: AsyncIterable<string>;
  /** Sends text to the client. Only protocol messages are written here. */
  readonly write: (text: string) => void;
  readonly model: Model;
  readonly info: PeerInfo;
  /** Receives diagnostics. They never go to the client's stream. */
  readonly log?: (text: string) => void;
}

/**
 * Serves one client over a stream of protocol messages. Resolves when the
 * input ends and every running request has finished.
 */
export async function serve(options: ServerOptions): Promise<void> {
  const { input, write, model, info } = options;
  const log = options.log ?? (() => undefined);
  const decoder = new LineDecoder();
  const running = new Map<RequestId, AbortController>();
  const pending = new Set<Promise<void>>();
  let initialized = false;

  const send = (message: Message): void => {
    write(encodeMessage(message));
  };
  const reply = (id: RequestId, result: unknown): void => {
    send({ jsonrpc: '2.0', id, result });
  };
  const fail = (id: RequestId, code: number, message: string): void => {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const initialize = (request: RequestMessage): void => {
    if (initialized) {
      fail(request.id, CoreErrorCode.AlreadyInitialized, 'initialize was already called');
      return;
    }
    if (!isInitializeParams(request.params)) {
      fail(request.id, ErrorCode.InvalidParams, 'initialize needs a protocol version and a client');
      return;
    }
    if (!isSupportedVersion(request.params.protocolVersion)) {
      fail(
        request.id,
        CoreErrorCode.UnsupportedVersion,
        `protocol version ${String(request.params.protocolVersion)} is not supported, this core speaks version ${String(PROTOCOL_VERSION)}`,
      );
      return;
    }
    initialized = true;
    const result: InitializeResult = { protocolVersion: PROTOCOL_VERSION, core: info };
    reply(request.id, result);
  };

  const chat = async (request: RequestMessage): Promise<void> => {
    if (!isChatSendParams(request.params)) {
      fail(request.id, ErrorCode.InvalidParams, 'chat/send needs a text');
      return;
    }
    if (running.has(request.id)) {
      fail(request.id, CoreErrorCode.RequestInProgress, 'a request with this id is still running');
      return;
    }
    const controller = new AbortController();
    running.set(request.id, controller);
    try {
      const events = model.stream({
        messages: [{ role: 'user', text: request.params.text }],
        signal: controller.signal,
      });
      for await (const event of events) {
        if (controller.signal.aborted) {
          break;
        }
        const params: ChatDeltaParams = { requestId: request.id, text: event.text };
        send({ jsonrpc: '2.0', method: CHAT_DELTA_METHOD, params });
      }
      const result: ChatSendResult = {
        stopReason: controller.signal.aborted ? 'cancelled' : 'end',
      };
      reply(request.id, result);
    } catch (error) {
      if (controller.signal.aborted) {
        const result: ChatSendResult = { stopReason: 'cancelled' };
        reply(request.id, result);
      } else {
        log(`chat request failed: ${error instanceof Error ? error.message : String(error)}`);
        fail(request.id, ErrorCode.InternalError, 'the model request failed');
      }
    } finally {
      running.delete(request.id);
    }
  };

  const handleRequest = (request: RequestMessage): void => {
    if (request.method === INITIALIZE_METHOD) {
      initialize(request);
      return;
    }
    if (!initialized) {
      fail(request.id, CoreErrorCode.NotInitialized, 'the first request must be initialize');
      return;
    }
    if (request.method === CHAT_SEND_METHOD) {
      const task = chat(request).finally(() => pending.delete(task));
      pending.add(task);
      return;
    }
    fail(request.id, ErrorCode.MethodNotFound, `unknown method ${request.method}`);
  };

  const handleNotification = (notification: NotificationMessage): void => {
    if (notification.method === CANCEL_METHOD && isCancelParams(notification.params)) {
      running.get(notification.params.id)?.abort();
    }
  };

  const handleLine = (line: string): void => {
    let message: Message;
    try {
      message = parseMessage(line);
    } catch (error) {
      if (error instanceof ProtocolError) {
        fail(null, error.code, error.message);
        return;
      }
      throw error;
    }
    if (isRequest(message)) {
      handleRequest(message);
    } else if (isNotification(message)) {
      handleNotification(message);
    } else {
      log('ignored a response, the core sends no requests');
    }
  };

  for await (const chunk of input) {
    for (const item of decoder.push(chunk)) {
      if (item.ok) {
        handleLine(item.line);
      } else {
        fail(null, item.error.code, item.error.message);
      }
    }
  }
  // The client is gone: stop what is still running and wait for it to settle.
  for (const controller of running.values()) {
    controller.abort();
  }
  await Promise.all(pending);
}
