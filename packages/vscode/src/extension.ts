import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';

/**
 * Called by VS Code the first time the extension is needed.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewId,
      new ChatViewProvider(context.extensionUri),
    ),
  );
}
