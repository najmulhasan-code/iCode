import type { ModelProvider, StopReason } from '@icode/protocol';
import * as vscode from 'vscode';
import { ChatSession } from './chatSession';
import {
  ChatPanelController,
  type NewChatResult,
  type ReopenResult,
  type SubmitResult,
} from './chatPanel';
import { ChatViewProvider } from './chatView';
import { CoreProcess } from './coreProcess';
import { readModelSettings, secretName } from './settings';

/** What the extension hands to its own end-to-end tests. It is not offered in normal use. */
export interface TestApi {
  setApiKey(provider: ModelProvider, apiKey: string): Promise<void>;
  sendMessage(text: string): Promise<{ readonly text: string; readonly stopReason: StopReason }>;
  /** Submits a message through the open chat panel, as if it had been typed there. */
  submitInChatView(text: string): Promise<SubmitResult>;
  /** Starts a new chat in the panel, without the notification. */
  newChat(): Promise<NewChatResult>;
  /** Reopens a chat in the panel, as Undo or the command does. */
  reopenChat(key?: number): Promise<ReopenResult>;
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
  void vscode.window.showInformationMessage(`The API key for ${provider} is saved.`);
}

async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const { provider } = readModelSettings();
  await secrets.delete(secretName(provider));
  void vscode.window.showInformationMessage(`The API key for ${provider} is removed.`);
}

/** Reopens a chat and says so when it cannot be reopened. */
async function reopenChat(panel: ChatPanelController, key?: number): Promise<void> {
  let result = await panel.reopen(key);
  if (result === 'closed') {
    await vscode.commands.executeCommand('icode.chat.focus');
    result = 'gone';
  }
  if (result === 'none') {
    void vscode.window.showInformationMessage('There is no previous chat to reopen.');
  } else if (result === 'gone') {
    void vscode.window.showWarningMessage('That chat can no longer be reopened.');
  }
}

/** Starts a new chat and offers to undo it. */
async function newChat(panel: ChatPanelController): Promise<void> {
  const result = await panel.newChat();
  if (result.kind === 'closed') {
    // Opening the panel shows an empty chat.
    await vscode.commands.executeCommand('icode.chat.focus');
    return;
  }
  if (result.kind === 'started') {
    // Each notification brings back the one conversation it was shown for.
    const choice = await vscode.window.showInformationMessage('Started a new chat.', 'Undo');
    if (choice === 'Undo') {
      await reopenChat(panel, result.previous);
    }
  }
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
  const session = new ChatSession({
    core,
    readSettings: readModelSettings,
    readKey: (provider) => context.secrets.get(secretName(provider)),
  });
  routes.chat = session;
  const panel = new ChatPanelController(session);
  const chatView = new ChatViewProvider(context.extensionUri, panel);

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
    vscode.commands.registerCommand('icode.newChat', () => newChat(panel)),
    vscode.commands.registerCommand('icode.reopenPreviousChat', () => reopenChat(panel)),
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
    submitInChatView: (text) => panel.submit(text),
    newChat: () => panel.newChat(),
    reopenChat: (key) => panel.reopen(key),
  };
}
