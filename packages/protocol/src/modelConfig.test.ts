import { describe, expect, it } from 'vitest';
import { isSetModelParams } from './modelConfig.js';

describe('isSetModelParams', () => {
  it.each([
    ['a provider and a key', { provider: 'anthropic', apiKey: 'k' }],
    [
      'every field',
      { provider: 'openai-compatible', apiKey: 'k', model: 'm', baseUrl: 'http://localhost:1' },
    ],
  ])('accepts %s', (_name, value) => {
    expect(isSetModelParams(value)).toBe(true);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['a missing provider', { apiKey: 'k' }],
    ['an unknown provider', { provider: 'other', apiKey: 'k' }],
    ['a provider named after a built-in', { provider: 'constructor', apiKey: 'k' }],
    ['a missing key', { provider: 'anthropic' }],
    ['an empty key', { provider: 'anthropic', apiKey: '' }],
    ['a key that is not text', { provider: 'anthropic', apiKey: 5 }],
    ['an empty model', { provider: 'anthropic', apiKey: 'k', model: '' }],
    ['an address that is not text', { provider: 'anthropic', apiKey: 'k', baseUrl: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(isSetModelParams(value)).toBe(false);
  });
});
