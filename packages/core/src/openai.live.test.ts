import { describe, expect, it } from 'vitest';
import type { ModelEvent } from './model.js';
import { createOpenAICompatibleModel } from './openai.js';

// This test calls a real OpenAI-compatible API and costs a small amount of
// money. It is skipped unless all three variables are set. OPENAI_BASE_URL is
// optional and points the test at another provider or a local server.
//
//   ICODE_LIVE_TESTS=1 OPENAI_API_KEY=<key> OPENAI_MODEL=<model> npx vitest run packages/core/src/openai.live.test.ts
const apiKey = process.env.OPENAI_API_KEY ?? '';
const modelName = process.env.OPENAI_MODEL ?? '';
const baseURL = process.env.OPENAI_BASE_URL ?? '';
const enabled = process.env.ICODE_LIVE_TESTS === '1' && apiKey !== '' && modelName !== '';

describe.skipIf(!enabled)('an OpenAI-compatible API', () => {
  it('streams a reply to a one-line question', { timeout: 120_000 }, async () => {
    const model = createOpenAICompatibleModel({
      apiKey,
      model: modelName,
      ...(baseURL === '' ? {} : { baseURL }),
    });
    const events: ModelEvent[] = [];
    const request = {
      messages: [
        { role: 'user', parts: [{ kind: 'text', text: 'Reply with the single word: ready' }] },
      ] as const,
      signal: new AbortController().signal,
    };
    for await (const event of model.stream(request)) {
      events.push(event);
    }

    const text = events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('');
    const end = events.at(-1);
    process.stderr.write(`live reply: ${JSON.stringify(text)}\nlive end: ${JSON.stringify(end)}\n`);

    expect(text.toLowerCase()).toContain('ready');
    expect(end).toMatchObject({ type: 'end', reason: 'end' });
  });
});
