import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isInitializeParams, isSupportedVersion } from './initialize.js';

describe('isInitializeParams', () => {
  it('accepts a version and a client description', () => {
    const params = { protocolVersion: 1, client: { name: 'vscode', version: '0.0.0' } };
    expect(isInitializeParams(params)).toBe(true);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a version given as text', { protocolVersion: '1', client: { name: 'a', version: '1' } }],
    ['a missing client', { protocolVersion: 1 }],
    ['a client without a version', { protocolVersion: 1, client: { name: 'a' } }],
  ])('rejects %s', (_name, value) => {
    expect(isInitializeParams(value)).toBe(false);
  });
});

describe('isSupportedVersion', () => {
  it('accepts the current version and rejects others', () => {
    expect(isSupportedVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedVersion(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isSupportedVersion(0)).toBe(false);
  });
});
