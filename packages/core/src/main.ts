import { createFixedModel } from './fixedModel.js';
import { serve } from './server.js';

/**
 * Entry point of the core process. The client talks to it over standard
 * input and output. Diagnostics go to standard error.
 */
async function main(): Promise<void> {
  process.stdin.setEncoding('utf8');
  await serve({
    input: process.stdin as AsyncIterable<string>,
    write: (text) => {
      process.stdout.write(text);
    },
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
