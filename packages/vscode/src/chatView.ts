import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChatPanelController } from './chatPanel';
import { PageLoads } from './pageLoads';

/**
 * Shows the chat panel in the iCode view of the side bar and connects its
 * page to the controller.
 *
 * The panel is a webview. It cannot reach the file system or the VS Code API,
 * and it never receives the API key. Its content security policy allows only
 * the files of the built page inside the extension: its script and the parts
 * it loads later, its stylesheet and the icon font. It allows no network, no
 * images, no forms, and no style written into markup.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'icode.chat';

  readonly #pageUri: vscode.Uri;
  readonly #controller: ChatPanelController;

  constructor(extensionUri: vscode.Uri, controller: ChatPanelController) {
    this.#pageUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    this.#controller = controller;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const { webview } = view;
    webview.options = {
      enableScripts: true,
      // Only the built page, never the workspace.
      localResourceRoots: [this.#pageUri],
    };
    const uri = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.#pageUri, file)).toString();
    const loads = new PageLoads(
      this.#controller,
      (message) => {
        void webview.postMessage(message);
      },
      (load) => {
        webview.html = renderChatHtml(webview.cspSource, uri('style.css'), uri('main.js'), load);
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
  // The page script is allowed by a value that is new for every page. The
  // parts it loads later are files of the extension, allowed by their source.
  const nonce = randomBytes(16).toString('base64');
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    `font-src ${cspSource}`,
    "connect-src 'none'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${policy};" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta id="icode-load" name="icode-load" content="${String(load)}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>iCode</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
