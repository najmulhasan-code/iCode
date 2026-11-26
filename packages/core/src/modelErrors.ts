import type { ModelErrorKind } from './model.js';

/** The kind of failure an HTTP status from a model provider stands for. */
export function kindForStatus(status: number): ModelErrorKind {
  if (status === 401) {
    return 'authentication';
  }
  if (status === 402 || status === 403) {
    return 'permission';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 408) {
    return 'connection';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  // A conflict is transient on these APIs, like a server-side failure.
  if (status === 409 || status >= 500) {
    return 'overloaded';
  }
  if (status >= 400) {
    return 'invalid_request';
  }
  return 'unexpected';
}

/**
 * Removes credentials from text that came from outside. A provider may echo
 * part of a request in an error message, and that text is written to the log.
 */
export function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey === '' ? text : text.split(apiKey).join('[redacted]');
  return withoutKey
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
}
