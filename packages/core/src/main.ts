import { createFixedModel } from './fixedModel.js';
import { serve } from './server.js';

/** Writes to standard output and resolves once the text has been handed to the system. */
function writeToStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Entry point of the core process. The client talks to it over standard
 * input and output. Diagnostics go to standard error.
 */
async function main(): Promise<void> {
  process.stdin.setEncoding('utf8');
  // A closed reader is reported through the failed write. Without a listener
  // the same error would also crash the process as an unhandled event.
  process.stdout.on('error', () => undefined);
  await serve({
    input: process.stdin as AsyncIterable<string>,
    write: writeToStdout,
    // Provider adapters are not connected yet, so the core answers with a fixed reply.
    model: createFixedModel(['The core is running. ', 'No model provider is connected yet.']),
    info: { name: 'icode-core', version: '0.0.0' },
    log: (text) => {
      process.stderr.write(`${text}\n`);
    },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
