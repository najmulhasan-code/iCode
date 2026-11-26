import { chatViewTests } from './chatView.test';
import { engineTests } from './engine.test';
import { runAll } from './harness';

/**
 * Entry point that VS Code calls inside the extension host.
 */
export function run(): Promise<void> {
  return runAll([...chatViewTests, ...engineTests]);
}
