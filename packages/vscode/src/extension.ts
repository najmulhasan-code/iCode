import type { ModelProvider, StopReason } from '@icode/protocol';
import * as vscode from 'vscode';
import { ChatSession } from './chatSession';
import { type ChatOutcome, ChatViewProvider } from './chatView';
import { CoreProcess } from './coreProcess';
import { readModelSettings, secretName } from './settings';

/** What the extension hands to its own end-to-end tests. It is not offered in normal use. */
export interface TestApi {
  setApiKey(provider: ModelProvider, apiKey: string): Promise<void>;
  sendMessage(text: string): Promise<{ readonly text: string; readonly stopReason: StopReason }>;
  /** Submits a message through the open chat panel, as if it had been typed there. */
  submitInChatView(text: string): Promise<ChatOutcome>;
}

async function setApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const { provider } = readModelSettings();
  const apiKey = await vscode.window.showInputBox({
    title: `iCode: API key for ${provider}`,
    prompt: 'The key is kept in the secret storage of VS Code and is sent only to this provider.',
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKey === undefined || apiKey.trim() === '') {
    return;
  }
  await secrets.store(secretName(provider), apiKey.trim());
  void vscode.window.showInformationMessage(`iCode: the API key for ${provider} is saved.`);
}

async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const { provider } = readModelSettings();
  await secrets.delete(secretName(provider));
  void vscode.window.showInformationMessage(`iCode: the API key for ${provider} is removed.`);
}

/**
 * Called by VS Code the first time the extension is needed.
 */
export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const log = vscode.window.createOutputChannel('iCode', { log: true });
  // Filled in below, because the core and the session refer to each other.
  const routes: { chat?: ChatSession } = {};
  const core = new CoreProcess({
    corePath: require.resolve('@icode/core'),
    clientVersion: (context.extension.packageJSON as { version: string }).version,
    log: (text) => {
      log.info(text);
    },
    onNotification: (notification) => routes.chat?.handleNotification(notification),
  });
  const session = new ChatSession(core, context.secrets);
  routes.chat = session;
  const chatView = new ChatViewProvider(context.extensionUri, session);

  context.subscriptions.push(
    log,
    {
      dispose: () => {
        core.dispose();
      },
    },
    // The panel keeps its conversation while the view is hidden.
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('icode.setApiKey', () => setApiKey(context.secrets)),
    vscode.commands.registerCommand('icode.clearApiKey', () => clearApiKey(context.secrets)),
  );

  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return undefined;
  }
  return {
    setApiKey: async (provider, apiKey) => {
      await context.secrets.store(secretName(provider), apiKey);
    },
    sendMessage: async (text) => {
      let reply = '';
      const stopReason = await session.send(text, (piece) => {
        reply += piece;
      });
      return { text: reply, stopReason };
    },
    submitInChatView: (text) => chatView.submit(text),
  };
}
