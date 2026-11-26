import { type IncomingHttpHeaders, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';

export interface SeenRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

/** Answers one request. `count` is 1 for the first request the server sees. */
export type Handler = (response: ServerResponse, request: SeenRequest, count: number) => void;

export interface StandIn {
  readonly url: string;
  readonly requests: readonly SeenRequest[];
  close(): Promise<void>;
}

/**
 * Starts a local HTTP server that stands in for a model provider. It is
 * closed when the current test finishes.
 */
export async function standIn(handler: Handler): Promise<StandIn> {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('end', () => {
      const seen: SeenRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
      };
      requests.push(seen);
      handler(response, seen, requests.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    return closing;
  };
  onTestFinished(close);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, requests, close };
}
