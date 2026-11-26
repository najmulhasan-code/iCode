import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Model, ModelEvent, ModelStopReason } from '../model.js';
import { standIn } from './standIn.js';

/** What the stand-in provider does with one request. */
export type Behaviour =
  | { readonly reply: readonly string[]; readonly stop: ModelStopReason }
  | { readonly status: number; readonly message?: string }
  /** Sends the pieces and then never finishes the reply. */
  | { readonly stall: readonly string[] };

/** What an adapter's tests supply so that the shared contract can run against it. */
export interface ContractHarness {
  /** The key `createModel` configures the model with. */
  readonly apiKey: string;
  /** Writes one behaviour in the provider's own wire format. */
  respond(response: ServerResponse, behaviour: Behaviour): void;
  createModel(url: string, retries: number): Model;
}

async function collect(model: Model, signal?: AbortSignal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  const request = {
    messages: [{ role: 'user', text: 'hi' }] as const,
    signal: signal ?? new AbortController().signal,
  };
  for await (const event of model.stream(request)) {
    events.push(event);
  }
  return events;
}

/**
 * The behaviour every model adapter must show, whatever provider it talks
 * to. Each adapter's test file calls this with its own harness.
 */
export function describeModelContract(name: string, harness: ContractHarness): void {
  const serve = (behaviour: (attempt: number) => Behaviour) =>
    standIn((response, _request, count) => {
      harness.respond(response, behaviour(count));
    });

  describe(`${name}: the model contract`, () => {
    it('passes a reply on as text events in order, then exactly one end event', async () => {
      const api = await serve(() => ({ reply: ['Hello', ', ', 'world'], stop: 'end' }));
      const events = await collect(harness.createModel(api.url, 0));

      expect(events.slice(0, -1)).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'world' },
      ]);
      expect(events.filter((event) => event.type === 'end')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'end' });
    });

    it.each(['end', 'max_tokens', 'refusal'] as const)(
      'reports the stop reason %s',
      async (stop) => {
        const api = await serve(() => ({ reply: ['x'], stop }));
        const events = await collect(harness.createModel(api.url, 0));

        expect(events.at(-1)).toMatchObject({ type: 'end', reason: stop });
      },
    );

    it.each([
      [401, 'authentication'],
      [403, 'permission'],
      [404, 'not_found'],
      [400, 'invalid_request'],
      [429, 'rate_limit'],
      [500, 'overloaded'],
    ])('reports status %i as the failure kind %s', async (status, kind) => {
      const api = await serve(() => ({ status }));

      await expect(collect(harness.createModel(api.url, 0))).rejects.toMatchObject({
        name: 'ModelError',
        kind,
        status,
      });
    });

    it('retries when the provider fails on its side', async () => {
      const api = await serve((attempt) =>
        attempt === 1 ? { status: 500 } : { reply: ['ok'], stop: 'end' },
      );
      const events = await collect(harness.createModel(api.url, 2));

      expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'end' });
      expect(api.requests).toHaveLength(2);
    });

    it('does not retry when the key is wrong', async () => {
      const api = await serve(() => ({ status: 401 }));

      await expect(collect(harness.createModel(api.url, 2))).rejects.toMatchObject({
        kind: 'authentication',
      });
      expect(api.requests).toHaveLength(1);
    });

    it('reports an unreachable server as a connection problem', async () => {
      const api = await serve(() => ({ status: 500 }));
      await api.close();

      await expect(collect(harness.createModel(api.url, 0))).rejects.toMatchObject({
        name: 'ModelError',
        kind: 'connection',
      });
    });

    it('stops quietly when the request is cancelled', async () => {
      const api = await serve(() => ({ stall: ['partial'] }));
      const controller = new AbortController();
      const events: ModelEvent[] = [];
      const request = {
        messages: [{ role: 'user', text: 'hi' }] as const,
        signal: controller.signal,
      };
      for await (const event of harness.createModel(api.url, 0).stream(request)) {
        events.push(event);
        controller.abort();
      }

      expect(events).toEqual([{ type: 'text', text: 'partial' }]);
    });

    it('never carries a key that the provider echoed back', async () => {
      const api = await serve(() => ({ status: 401, message: `bad key ${harness.apiKey}` }));

      const failure = await collect(harness.createModel(api.url, 0)).catch(
        (error: unknown) => error,
      );
      const message = failure instanceof Error ? failure.message : '';
      expect(message).toContain('[redacted]');
      expect(message).not.toContain(harness.apiKey);
    });
  });
}
