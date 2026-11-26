import {
  CANCEL_METHOD,
  CHAT_DELTA_METHOD,
  CHAT_SEND_METHOD,
  type CancelParams,
  type ChatDeltaParams,
  type ChatSendParams,
  type ChatSendResult,
  CoreErrorCode,
  type ModelProvider,
  type NotificationMessage,
  type RequestId,
  RpcError,
  SET_MODEL_METHOD,
  type SetModelParams,
  type StopReason,
} from '@icode/protocol';
import type { CoreSession } from './coreProcess';
import type { ModelSettings } from './settings';

/** A failure with a message written for the person using the editor. */
export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

/** What a chat session needs from the editor. Passed in, so the session can be tested alone. */
export interface ChatSessionDependencies {
  /** Returns the running core, starting it when needed. */
  readonly core: { session(): Promise<CoreSession> };
  /** Reads the model the user has chosen. */
  readonly readSettings: () => ModelSettings;
  /** Reads the saved API key of a provider, if there is one. */
  readonly readKey: (provider: ModelProvider) => PromiseLike<string | undefined>;
}

const MESSAGE_BY_FAILURE_KIND: ReadonlyMap<string, string> = new Map([
  ['authentication', 'The provider rejected the API key. Set it again with "iCode: Set API Key".'],
  ['permission', 'The provider refused the request. Check the account and its billing.'],
  ['not_found', 'The provider does not know this model. Check the "iCode: Model" setting.'],
  ['invalid_request', 'The provider rejected the request as invalid.'],
  ['rate_limit', 'The provider is limiting requests right now. Try again in a moment.'],
  ['overloaded', 'The provider is having trouble right now. Try again in a moment.'],
  ['connection', 'The provider could not be reached. Check the connection and the address.'],
]);

function toChatError(error: unknown): ChatError {
  if (error instanceof ChatError) {
    return error;
  }
  if (error instanceof RpcError) {
    if (error.code === CoreErrorCode.ModelRequestFailed) {
      const data = error.data as { kind?: unknown } | undefined;
      const kind = typeof data?.kind === 'string' ? data.kind : '';
      return new ChatError(MESSAGE_BY_FAILURE_KIND.get(kind) ?? 'The model request failed.');
    }
    // Other error answers carry messages written in the core, which are safe to show.
    return new ChatError(error.message);
  }
  return new ChatError(error instanceof Error ? error.message : 'The request failed.');
}

/**
 * Sends chat messages to the core and passes the pieces of each reply on. It
 * tells the core which model to use whenever the settings, the key or the
 * core process have changed. One reply is written at a time.
 */
export class ChatSession {
  readonly #dependencies: ChatSessionDependencies;
  readonly #listeners = new Map<RequestId, (text: string) => void>();
  #applied: { readonly generation: number; readonly fingerprint: string } | undefined;
  #active: { readonly session: CoreSession; readonly id: RequestId } | undefined;
  #sending = false;
  #cancelRequested = false;

  constructor(dependencies: ChatSessionDependencies) {
    this.#dependencies = dependencies;
  }

  /** Routes a notification from the core to the request it belongs to. */
  handleNotification(notification: NotificationMessage): void {
    if (notification.method !== CHAT_DELTA_METHOD) {
      return;
    }
    const params = notification.params as Partial<ChatDeltaParams> | undefined;
    if (params?.requestId !== undefined && typeof params.text === 'string') {
      this.#listeners.get(params.requestId)?.(params.text);
    }
  }

  /**
   * Sends one message and resolves when the reply has ended. A send that is
   * cancelled before the message has left resolves with `cancelled`, and
   * nothing is sent.
   *
   * @throws ChatError with a message for the person using the editor.
   */
  async send(text: string, onText: (text: string) => void): Promise<StopReason> {
    // One reply at a time: the settings sent to the core and the reply that
    // follows must belong to the same request.
    if (this.#sending) {
      throw new ChatError('A reply is still being written. Wait for it or stop it first.');
    }
    this.#sending = true;
    this.#cancelRequested = false;
    try {
      const { core, readSettings, readKey } = this.#dependencies;
      const settings = readSettings();
      const apiKey = await readKey(settings.provider);
      if (apiKey === undefined || apiKey === '') {
        throw new ChatError(
          `No API key is set for the provider "${settings.provider}". Run "iCode: Set API Key".`,
        );
      }
      if (this.#wasCancelled()) {
        return 'cancelled';
      }
      const session = await core.session();
      if (this.#wasCancelled()) {
        return 'cancelled';
      }
      const params: SetModelParams = { ...settings, apiKey };
      const fingerprint = JSON.stringify(params);
      if (
        this.#applied?.generation !== session.generation ||
        this.#applied.fingerprint !== fingerprint
      ) {
        await session.connection.request(SET_MODEL_METHOD, params);
        this.#applied = { generation: session.generation, fingerprint };
      }
      if (this.#wasCancelled()) {
        return 'cancelled';
      }

      const chat: ChatSendParams = { text };
      const sent = session.connection.send(CHAT_SEND_METHOD, chat);
      this.#listeners.set(sent.id, onText);
      this.#active = { session, id: sent.id };
      try {
        const result = (await sent.response) as ChatSendResult;
        return result.stopReason;
      } finally {
        this.#listeners.delete(sent.id);
        this.#active = undefined;
      }
    } catch (error) {
      throw toChatError(error);
    } finally {
      this.#sending = false;
    }
  }

  /**
   * Whether a stop was asked for. It is read through a method because the
   * flag changes while `send` is waiting, which the type checker cannot see.
   */
  #wasCancelled(): boolean {
    return this.#cancelRequested;
  }

  /**
   * Stops the reply that is being written. It also works before the message
   * has left, while the key is read or the core is starting.
   */
  cancel(): void {
    if (!this.#sending) {
      return;
    }
    this.#cancelRequested = true;
    if (this.#active !== undefined) {
      const params: CancelParams = { id: this.#active.id };
      this.#active.session.connection.notify(CANCEL_METHOD, params);
    }
  }
}
