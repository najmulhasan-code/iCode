import type { ModelProvider, StopReason } from '@icode/protocol';
import * as vscode from 'vscode';
import { ChatSession } from './chatSession';
import {
  ChatPanelController,
  type ChatSummary,
  type NewChatResult,
  type OpenResult,
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
  /** Starts a new chat in the panel. */
  newChat(): Promise<NewChatResult>;
  /** The chats the chat list would show. */
  chats(): ChatSummary[];
  /** Opens a chat in the panel, as picking it from the chat list does. */
  openChat(key: number): Promise<OpenResult>;
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

/** Brings the chat panel into view. An opening panel shows the current chat. */
async function focusPanel(): Promise<void> {
  await vscode.commands.executeCommand('icode.chat.focus');
}

/** Starts a new chat. With the panel closed, the panel opens and shows it. */
async function newChat(panel: ChatPanelController): Promise<void> {
  await panel.newChat();
  if (!panel.isOpen) {
    await focusPanel();
  }
}

/** Shows the chat list in the panel, opening the panel when it is closed. */
async function showChatHistory(panel: ChatPanelController): Promise<void> {
  panel.showHistory();
  if (!panel.isOpen) {
    await focusPanel();
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
  const panel = new ChatPanelController(session, {
    actions: {
      copy: async (text) => {
        await vscode.env.clipboard.writeText(text);
      },
      // The controller passes only links that are full https or mailto addresses.
      openLink: (url) => {
        void vscode.env.openExternal(vscode.Uri.parse(url, true));
      },
    },
  });
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
    vscode.commands.registerCommand('icode.chatHistory', () => showChatHistory(panel)),
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
    chats: () => panel.chats(),
    openChat: (key) => panel.open(key),
  };
}
