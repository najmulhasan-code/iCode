import { type ChildProcess, spawn } from 'node:child_process';
import {
  ClientConnection,
  INITIALIZE_METHOD,
  type InitializeParams,
  type NotificationMessage,
  PROTOCOL_VERSION,
} from '@icode/protocol';

/** A running core and the connection to it. */
export interface CoreSession {
  readonly connection: ClientConnection;
  /** Changes every time the core is started again, so callers know to send their settings again. */
  readonly generation: number;
}

export interface CoreProcessOptions {
  /** Path of the core's entry file. */
  readonly corePath: string;
  readonly clientVersion: string;
  /** Receives what the core writes to standard error, and notes about its lifetime. */
  readonly log: (text: string) => void;
  readonly onNotification: (notification: NotificationMessage) => void;
}

/**
 * Owns the core process. The process is started the first time it is needed
 * and started again after it has exited.
 */
export class CoreProcess {
  readonly #options: CoreProcessOptions;
  #child: ChildProcess | undefined;
  #connection: ClientConnection | undefined;
  #session: Promise<CoreSession> | undefined;
  #generation = 0;
  #disposed = false;

  constructor(options: CoreProcessOptions) {
    this.#options = options;
  }

  /** Returns the running core, starting it and completing the handshake when needed. */
  session(): Promise<CoreSession> {
    if (this.#disposed) {
      return Promise.reject(new Error('iCode is shutting down'));
    }
    this.#session ??= this.#start();
    return this.#session;
  }

  /** Stops the core for good. Requests that are waiting are rejected, and no new core is started. */
  dispose(): void {
    this.#disposed = true;
    this.#connection?.close(new Error('iCode is shutting down'));
    this.#connection = undefined;
    this.#child?.kill();
    this.#child = undefined;
    this.#session = undefined;
  }

  async #start(): Promise<CoreSession> {
    const { corePath, clientVersion, log, onNotification } = this.#options;
    // The extension host is Electron. This variable makes its binary behave as plain Node.
    const child = spawn(process.execPath, [corePath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    this.#generation += 1;
    const generation = this.#generation;

    const connection = new ClientConnection({
      write: (text) => {
        child.stdin.write(text);
      },
      onNotification,
      onProtocolError: (error) => {
        log(`the core sent text that is not a protocol message: ${error.message}`);
      },
      onCallbackError: () => {
        log('handling a message from the core failed');
      },
    });
    this.#connection = connection;
    const ended = (reason: string): void => {
      connection.close(new Error(reason));
      if (this.#child === child) {
        this.#child = undefined;
        this.#connection = undefined;
        this.#session = undefined;
      }
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      connection.receive(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      log(chunk.trimEnd());
    });
    // A failed write surfaces through the exit that follows it.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      log(`the core could not be started: ${error.message}`);
      ended('the iCode core could not be started');
    });
    child.on('exit', (code) => {
      log(`the core exited with code ${String(code)}`);
      ended('the iCode core stopped');
    });

    const params: InitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'icode-vscode', version: clientVersion },
    };
    try {
      await connection.request(INITIALIZE_METHOD, params);
    } catch (error) {
      child.kill();
      ended('the iCode core did not complete the handshake');
      throw error;
    }
    return { connection, generation };
  }
}
