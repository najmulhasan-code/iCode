import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChatPanelController, PanelPort } from './chatPanel';

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
    const port: PanelPort = {
      post: (message) => {
        void webview.postMessage(message);
      },
    };
    webview.onDidReceiveMessage((message: unknown) => {
      // The page says when its script is running. Until then it cannot receive anything.
      if ((message as { type?: unknown } | null)?.type === 'ready') {
        this.#controller.attach(port);
      } else {
        this.#controller.handle(port, message);
      }
    });
    view.onDidDispose(() => {
      this.#controller.detach(port);
    });
    const uri = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.#mediaUri, file)).toString();
    webview.html = renderChatHtml(webview.cspSource, uri('chat.css'), uri('chat.js'));
  }
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
