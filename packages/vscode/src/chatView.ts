import { randomBytes } from 'node:crypto';
import type { StopReason } from '@icode/protocol';
import * as vscode from 'vscode';
import type { ChatSession } from './chatSession';

/** How one message sent from the panel ended. */
export type ChatOutcome =
  { readonly text: string; readonly stopReason: StopReason } | { readonly error: string };

/** The logo, drawn inline so that its dot can be animated by the stylesheet. */
const MARK = `<svg class="mark" viewBox="0 0 128 128" aria-hidden="true">
      <rect class="mark-frame" width="128" height="128" rx="28" />
      <rect class="mark-dot" x="55" y="26.5" width="18" height="18" rx="4" />
      <rect class="mark-stem" x="55" y="55.5" width="18" height="46" rx="4" />
    </svg>`;

/**
 * Provides the chat panel shown in the iCode view of the side bar.
 *
 * The panel is a webview. It cannot reach the file system or the VS Code API,
 * and its content security policy allows the bundled stylesheet and the one
 * bundled script and nothing else. It never receives the API key.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'icode.chat';

  readonly #mediaUri: vscode.Uri;
  readonly #chat: ChatSession;
  #view: vscode.WebviewView | undefined;
  #ready: Promise<void> = Promise.resolve();
  #busy = false;
  #waiting: ((outcome: ChatOutcome) => void)[] = [];

  constructor(extensionUri: vscode.Uri, chat: ChatSession) {
    this.#mediaUri = vscode.Uri.joinPath(extensionUri, 'media');
    this.#chat = chat;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const { webview } = view;
    this.#view = view;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.#mediaUri],
    };
    this.#ready = new Promise((resolve) => {
      webview.onDidReceiveMessage((message: unknown) => {
        if (isMessage(message, 'ready')) {
          resolve();
        } else {
          this.#handle(webview, message);
        }
      });
    });
    view.onDidDispose(() => {
      this.#view = undefined;
    });
    const uri = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.#mediaUri, file)).toString();
    webview.html = renderChatHtml(webview.cspSource, uri('chat.css'), uri('chat.js'));
  }

  /**
   * Submits a message as if it had been typed into the panel, and resolves
   * with how it ended. The panel must be open.
   */
  async submit(text: string): Promise<ChatOutcome> {
    const view = this.#view;
    if (view === undefined) {
      throw new Error('the chat panel is not open');
    }
    await this.#ready;
    const outcome = new Promise<ChatOutcome>((resolve) => {
      this.#waiting.push(resolve);
    });
    await view.webview.postMessage({ type: 'submit', text });
    return outcome;
  }

  #handle(webview: vscode.Webview, message: unknown): void {
    if (isMessage(message, 'cancel')) {
      this.#chat.cancel();
      return;
    }
    // The panel is not trusted: only a well-formed request is acted on.
    if (!isMessage(message, 'send') || typeof message.text !== 'string') {
      return;
    }
    const text = message.text.trim();
    if (text === '' || this.#busy) {
      return;
    }
    this.#busy = true;
    void this.#send(webview, text).finally(() => {
      this.#busy = false;
    });
  }

  async #send(webview: vscode.Webview, text: string): Promise<void> {
    let reply = '';
    let outcome: ChatOutcome;
    try {
      const stopReason = await this.#chat.send(text, (piece) => {
        reply += piece;
        void webview.postMessage({ type: 'text', text: piece });
      });
      outcome = { text: reply, stopReason };
      void webview.postMessage({ type: 'end', stopReason });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed.';
      outcome = { error: message };
      void webview.postMessage({ type: 'error', message });
    }
    for (const resolve of this.#waiting.splice(0)) {
      resolve(outcome);
    }
  }
}

function isMessage(value: unknown, type: string): value is { type: string; text?: unknown } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type;
}

function renderChatHtml(cspSource: string, styleUri: string, scriptUri: string): string {
  // The script is allowed by a value that is new for every page, so nothing
  // else can run even if text from a model were ever treated as markup.
  const nonce = randomBytes(16).toString('base64');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>iCode</title>
  </head>
  <body>
    <main id="messages" class="messages" aria-label="Conversation" aria-live="polite">
      <div id="welcome" class="welcome moving">
        ${MARK}
        <p>Describe a task</p>
      </div>
    </main>
    <div id="status" class="status moving" hidden>
      ${MARK}
      <span>Working</span>
    </div>
    <div class="composer">
      <textarea id="input" aria-label="Message" placeholder="Describe a task" rows="3"></textarea>
      <div class="actions">
        <button id="stop" type="button" class="secondary" hidden>Stop</button>
        <button id="send" type="button" disabled>Send</button>
      </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
