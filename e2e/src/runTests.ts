import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Downloads VS Code if needed, starts it with the extension loaded and no
 * other extensions, and runs the tests inside it.
 */
async function main(): Promise<void> {
  // A run started from a VS Code terminal inherits that editor's environment,
  // which makes the test instance misbehave. Start from a clean one.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('VSCODE_') || name === 'ELECTRON_RUN_AS_NODE') {
      Reflect.deleteProperty(process.env, name);
    }
  }

  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '../../packages/vscode'),
    extensionTestsPath: path.resolve(__dirname, 'index.js'),
    launchArgs: ['--disable-extensions'],
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
