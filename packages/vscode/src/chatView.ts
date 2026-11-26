import * as vscode from 'vscode';

/**
 * Provides the chat panel shown in the iCode view of the side bar.
 *
 * The panel is a webview. It cannot reach the file system or the VS Code API,
 * and its content security policy allows only the bundled stylesheet.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'icode.chat';

  readonly #mediaUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.#mediaUri = vscode.Uri.joinPath(extensionUri, 'media');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const { webview } = view;
    webview.options = {
      enableScripts: false,
      localResourceRoots: [this.#mediaUri],
    };
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.#mediaUri, 'chat.css'));
    webview.html = renderChatHtml(webview.cspSource, styleUri.toString());
  }
}

function renderChatHtml(cspSource: string, styleUri: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource};" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>iCode</title>
  </head>
  <body>
    <main class="messages" aria-label="Conversation">
      <p class="empty">No messages yet.</p>
    </main>
    <div class="composer">
      <textarea aria-label="Message" placeholder="Describe a task" rows="3"></textarea>
      <button type="button" disabled>Send</button>
    </div>
  </body>
</html>`;
}
