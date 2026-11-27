import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChatPanelController } from './chatPanel';
import { PageLoads } from './pageLoads';

/** The logo, drawn inline so that its dot can be animated by the stylesheet. */
const MARK = `<svg class="mark" viewBox="0 0 128 128" aria-hidden="true">
      <rect class="mark-frame" width="128" height="128" rx="28" />
      <rect class="mark-dot" x="55" y="26.5" width="18" height="18" rx="4" />
      <rect class="mark-stem" x="55" y="55.5" width="18" height="46" rx="4" />
    </svg>`;

/**
 * Shows the chat panel in the iCode view of the side bar and connects its
 * page to the controller.
 *
 * The panel is a webview. It cannot reach the file system or the VS Code API,
 * and its content security policy allows the bundled stylesheet and the one
 * bundled script and nothing else. It never receives the API key.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'icode.chat';

  readonly #mediaUri: vscode.Uri;
  readonly #controller: ChatPanelController;

  constructor(extensionUri: vscode.Uri, controller: ChatPanelController) {
    this.#mediaUri = vscode.Uri.joinPath(extensionUri, 'media');
    this.#controller = controller;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const { webview } = view;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.#mediaUri],
    };
    const uri = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.#mediaUri, file)).toString();
    const loads = new PageLoads(
      this.#controller,
      (message) => {
        void webview.postMessage(message);
      },
      (load) => {
        webview.html = renderChatHtml(webview.cspSource, uri('chat.css'), uri('chat.js'), load);
      },
    );
    webview.onDidReceiveMessage((message: unknown) => {
      loads.receive(message);
    });
    view.onDidDispose(() => {
      loads.dispose();
    });
    loads.load();
  }
}

function renderChatHtml(
  cspSource: string,
  styleUri: string,
  scriptUri: string,
  load: number,
): string {
  // The script is allowed by a value that is new for every page, so nothing
  // else can run even if text from a model were ever treated as markup.
  const nonce = randomBytes(16).toString('base64');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta id="icode-load" name="icode-load" content="${String(load)}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>iCode</title>
  </head>
  <body>
    <div id="chat" class="chat">
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
    </div>
    <section id="history" class="history" aria-label="Chat history" hidden>
      <div class="history-bar">
        <button id="history-back" type="button" class="icon" aria-label="Back to the chat" title="Back to the chat">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3 5.5 8l5 5" /></svg>
        </button>
        <input id="history-search" type="text" role="combobox" aria-label="Search chats" aria-controls="history-list" aria-expanded="true" aria-autocomplete="list" placeholder="Search chats" autocomplete="off" spellcheck="false" />
      </div>
      <ul id="history-list" class="history-list" role="listbox" aria-label="Chats"></ul>
      <p id="history-empty" class="history-empty" hidden></p>
    </section>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
