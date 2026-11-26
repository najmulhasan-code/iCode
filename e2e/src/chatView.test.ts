import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { type TestCase, waitFor } from './harness';

const EXTENSION_ID = 'najmulhasan-code.icode';

export const chatViewTests: readonly TestCase[] = [
  {
    name: 'chat view: opening the view activates the extension',
    async run() {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, 'the extension is not installed');
      assert.equal(extension.isActive, false, 'the extension activated before its view was opened');

      await vscode.commands.executeCommand('icode.chat.focus');
      await waitFor(() => extension.isActive);
    },
  },
];
