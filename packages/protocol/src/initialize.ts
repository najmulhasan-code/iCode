/**
 * Version of the message protocol spoken between the core and its clients.
 *
 * A client and a core exchange this number before any other message and
 * refuse to continue when they disagree.
 */
export const PROTOCOL_VERSION = 1;

/** Name of the first request a client sends. */
export const INITIALIZE_METHOD = 'initialize';

export interface PeerInfo {
  readonly name: string;
  readonly version: string;
}

export interface InitializeParams {
  readonly protocolVersion: number;
  readonly client: PeerInfo;
}

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly core: PeerInfo;
}

function isPeerInfo(value: unknown): value is PeerInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const peer = value as Record<string, unknown>;
  return typeof peer.name === 'string' && typeof peer.version === 'string';
}

/** Checks the shape of the params of an initialize request. */
export function isInitializeParams(value: unknown): value is InitializeParams {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const params = value as Record<string, unknown>;
  return typeof params.protocolVersion === 'number' && isPeerInfo(params.client);
}

/** True when this build can talk to a peer that speaks the given version. */
export function isSupportedVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}
