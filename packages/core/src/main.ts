import type { SetModelParams } from '@icode/protocol';
import { createAnthropicModel } from './anthropic.js';
import type { Model } from './model.js';
import { createOpenAICompatibleModel } from './openai.js';
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

/** Builds the adapter for the provider the client chose. */
function createModel(params: SetModelParams): Model {
  const shared = {
    apiKey: params.apiKey,
    ...(params.baseUrl === undefined ? {} : { baseURL: params.baseUrl }),
  };
  if (params.provider === 'anthropic') {
    return createAnthropicModel({
      ...shared,
      ...(params.model === undefined ? {} : { model: params.model }),
    });
  }
  if (params.model === undefined) {
    throw new Error('the openai-compatible provider needs a model name');
  }
  return createOpenAICompatibleModel({ ...shared, model: params.model });
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
    createModel,
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
