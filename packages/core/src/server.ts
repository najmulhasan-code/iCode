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
  type ModelRequestFailedData,
  type NotificationMessage,
  PROTOCOL_VERSION,
  type PeerInfo,
  ProtocolError,
  type RequestId,
  type RequestMessage,
  SET_MODEL_METHOD,
  type SetModelParams,
  type StopReason,
  encodeMessage,
  isCancelParams,
  isChatSendParams,
  isInitializeParams,
  isNotification,
  isRequest,
  isSetModelParams,
  isSupportedVersion,
  parseMessage,
} from '@icode/protocol';
import { type Model, ModelError } from './model.js';

export interface ServerOptions {
  /** Text from the client, in chunks of any size. */
  readonly input: AsyncIterable<string>;
  /**
   * Sends text to the client. Only protocol messages are written here. When
   * it returns a promise, the next write waits for it, so a slow client slows
   * the core down and output does not pile up in memory.
   */
  readonly write: (text: string) => void | Promise<void>;
  /** The model to use until the client chooses one. */
  readonly model?: Model;
  /**
   * Builds the model a client asks for with `model/set`. Without it the
   * request is not offered. It may throw to refuse the parameters, and the
   * message of that error is sent to the client.
   */
  readonly createModel?: (params: SetModelParams) => Model;
  readonly info: PeerInfo;
  /** Receives diagnostics. They never go to the client's stream. */
  readonly log?: (text: string) => void;
  /** How long to wait for pending output after the client stops sending. */
  readonly shutdownTimeoutMs?: number;
}

/** Resolves when the signal aborts. */
function whenAborted(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
    } else {
      signal.addEventListener(
        'abort',
        () => {
          resolve('aborted');
        },
        { once: true },
      );
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serves one client over a stream of protocol messages.
 *
 * Resolves when the client stops sending and pending work has settled.
 * Rejects when the connection itself fails: reading the input throws, or a
 * write does. In every case all running model requests are aborted first, and
 * nothing is written after a failed write.
 */
export async function serve(options: ServerOptions): Promise<void> {
  const { input, write, info, createModel } = options;
  let model = options.model;
  const log = options.log ?? (() => undefined);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
  const decoder = new LineDecoder();
  const running = new Map<RequestId, AbortController>();
  const tasks = new Set<Promise<void>>();
  /** Aborted when the connection can no longer be used. */
  const connection = new AbortController();
  const connectionClosed = whenAborted(connection.signal);
  let failure: { readonly error: unknown } | undefined;
  let initialized = false;

  const closeConnection = (error?: unknown): void => {
    if (error !== undefined) {
      failure ??= { error };
    }
    connection.abort();
    for (const controller of running.values()) {
      controller.abort();
    }
  };

  /** Writes are queued so that messages never interleave and each waits for the one before. */
  let lastWrite: Promise<void> = Promise.resolve();
  const send = (message: Message): Promise<unknown> => {
    if (connection.signal.aborted) {
      return Promise.resolve();
    }
    const written = lastWrite.then(async () => {
      if (!connection.signal.aborted) {
        await write(encodeMessage(message));
      }
    });
    lastWrite = written.catch((error: unknown) => {
      closeConnection(error);
    });
    // A caller never waits on a connection that has been closed.
    return Promise.race([lastWrite, connectionClosed]);
  };
  const reply = (id: RequestId, result: unknown): Promise<unknown> =>
    send({ jsonrpc: '2.0', id, result });
  const fail = (id: RequestId, code: number, message: string): Promise<unknown> =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  const initialize = (request: RequestMessage): void => {
    if (initialized) {
      void fail(request.id, CoreErrorCode.AlreadyInitialized, 'initialize was already called');
      return;
    }
    if (!isInitializeParams(request.params)) {
      void fail(
        request.id,
        ErrorCode.InvalidParams,
        'initialize needs a protocol version and a client',
      );
      return;
    }
    if (!isSupportedVersion(request.params.protocolVersion)) {
      void fail(
        request.id,
        CoreErrorCode.UnsupportedVersion,
        `protocol version ${String(request.params.protocolVersion)} is not supported, this core speaks version ${String(PROTOCOL_VERSION)}`,
      );
      return;
    }
    initialized = true;
    const result: InitializeResult = { protocolVersion: PROTOCOL_VERSION, core: info };
    void reply(request.id, result);
  };

  const setModel = (request: RequestMessage): void => {
    if (createModel === undefined) {
      void fail(request.id, ErrorCode.MethodNotFound, `unknown method ${request.method}`);
      return;
    }
    // The parameters hold a credential, so they are never logged or echoed.
    if (!isSetModelParams(request.params)) {
      void fail(request.id, ErrorCode.InvalidParams, 'model/set needs a known provider and a key');
      return;
    }
    try {
      model = createModel(request.params);
    } catch (error) {
      void fail(request.id, ErrorCode.InvalidParams, describe(error));
      return;
    }
    void reply(request.id, {});
  };

  /** Runs one chat request to its single answer. It never rejects. */
  const chat = async (request: RequestMessage, text: string, model: Model): Promise<void> => {
    const controller = new AbortController();
    running.set(request.id, controller);
    const cancelled = whenAborted(controller.signal);
    let stopReason: StopReason | undefined;
    try {
      const stream = model.stream({
        messages: [{ role: 'user', text }],
        signal: controller.signal,
      });
      const events = stream[Symbol.asyncIterator]();
      try {
        while (stopReason === undefined) {
          // A provider may never answer, so its progress is raced against cancellation.
          const next = events.next();
          next.catch(() => undefined);
          const step = await Promise.race([next, cancelled]);
          if (step === 'aborted') {
            stopReason = 'cancelled';
          } else if (step.done === true) {
            throw new Error('the model reply ended without an end event');
          } else if (step.value.type === 'text') {
            const params: ChatDeltaParams = { requestId: request.id, text: step.value.text };
            await Promise.race([
              send({ jsonrpc: '2.0', method: CHAT_DELTA_METHOD, params }),
              cancelled,
            ]);
            if (controller.signal.aborted) {
              stopReason = 'cancelled';
            }
          } else {
            stopReason = step.value.reason;
          }
        }
      } finally {
        // Not awaited: a provider that ignores cancellation must not hold the request open.
        void Promise.resolve(events.return?.()).catch(() => undefined);
      }
      const result: ChatSendResult = {
        stopReason: controller.signal.aborted ? 'cancelled' : stopReason,
      };
      await reply(request.id, result);
    } catch (error) {
      if (controller.signal.aborted) {
        const result: ChatSendResult = { stopReason: 'cancelled' };
        await reply(request.id, result);
      } else if (error instanceof ModelError) {
        // The provider's own wording stays in the log. The client gets the kind.
        log(`model request failed (${error.kind}): ${error.message}`);
        const data: ModelRequestFailedData = { kind: error.kind };
        await send({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: CoreErrorCode.ModelRequestFailed,
            message: 'the model request failed',
            data,
          },
        });
      } else {
        log(`chat request failed: ${describe(error)}`);
        await fail(request.id, ErrorCode.InternalError, 'the model request failed');
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
      void fail(request.id, CoreErrorCode.NotInitialized, 'the first request must be initialize');
      return;
    }
    if (request.method === SET_MODEL_METHOD) {
      setModel(request);
      return;
    }
    if (request.method !== CHAT_SEND_METHOD) {
      void fail(request.id, ErrorCode.MethodNotFound, `unknown method ${request.method}`);
      return;
    }
    if (!isChatSendParams(request.params)) {
      void fail(request.id, ErrorCode.InvalidParams, 'chat/send needs a text');
      return;
    }
    if (running.has(request.id)) {
      void fail(
        request.id,
        CoreErrorCode.RequestInProgress,
        'a request with this id is still running',
      );
      return;
    }
    if (model === undefined) {
      void fail(request.id, CoreErrorCode.ModelNotSet, 'no model has been chosen yet');
      return;
    }
    // A request keeps the model it started with, even if another is chosen meanwhile.
    const task = chat(request, request.params.text, model)
      .catch((error: unknown) => {
        closeConnection(error);
      })
      .finally(() => tasks.delete(task));
    tasks.add(task);
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
        void fail(null, error.code, error.message);
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

  try {
    const chunks = input[Symbol.asyncIterator]();
    for (;;) {
      const next = chunks.next();
      next.catch(() => undefined);
      const step = await Promise.race([next, connectionClosed]);
      if (step === 'aborted' || step.done === true) {
        break;
      }
      for (const item of decoder.push(step.value)) {
        if (item.ok) {
          handleLine(item.line);
        } else {
          void fail(null, item.error.code, item.error.message);
        }
      }
    }
  } catch (error) {
    closeConnection(error);
  } finally {
    // The client has stopped sending: stop the model requests, then give
    // their final answers a bounded time to be written.
    for (const controller of running.values()) {
      controller.abort();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, shutdownTimeoutMs);
    });
    const settled = (async () => {
      await Promise.all(tasks);
      await lastWrite;
    })();
    await Promise.race([settled, timedOut, connectionClosed]);
    clearTimeout(timer);
    closeConnection();
  }
  if (failure !== undefined) {
    throw failure.error instanceof Error ? failure.error : new Error(describe(failure.error));
  }
}
