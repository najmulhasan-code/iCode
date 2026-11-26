import type { Model, ModelEvent, ModelRequest } from './model.js';

/**
 * A stand-in model that replies with the same pieces of text every time. It
 * lets the core run and be tested without a provider or a key.
 */
export function createFixedModel(pieces: readonly string[], delayMs = 0): Model {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      for (const text of pieces) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (request.signal.aborted) {
          return;
        }
        yield { type: 'text', text };
      }
      yield { type: 'end', reason: 'end' };
    },
  };
}
