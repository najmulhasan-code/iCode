import { describe, expect, it } from 'vitest';
import { createAnthropicModel } from './anthropic.js';
import type { ModelEvent } from './model.js';

// This test calls the real Anthropic API and costs a small amount of money.
// It is skipped unless both variables are set:
//
//   ICODE_LIVE_TESTS=1 ANTHROPIC_API_KEY=<key> npx vitest run packages/core/src/anthropic.live.test.ts
const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
const enabled = process.env.ICODE_LIVE_TESTS === '1' && apiKey !== '';

describe.skipIf(!enabled)('the Anthropic API', () => {
  it('streams a reply to a one-line question', { timeout: 120_000 }, async () => {
    const model = createAnthropicModel({ apiKey, maxTokens: 2000 });
    const events: ModelEvent[] = [];
    const request = {
      messages: [{ role: 'user', text: 'Reply with the single word: ready' }] as const,
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
    expect(end?.type === 'end' ? end.usage?.outputTokens : 0).toBeGreaterThan(0);
  });
});
