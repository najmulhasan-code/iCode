import { describe, expect, it } from 'vitest';
import { validateLink } from './links';

describe('validateLink', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['https://example.com/docs?q=1#part', 'https://example.com/docs?q=1#part'],
    ['HTTPS://Example.com/Path', 'https://example.com/Path'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
  ])('allows %s', (value, canonical) => {
    expect(validateLink(value)).toBe(canonical);
  });

  it.each([
    ['plain web over HTTP', 'http://example.com'],
    ['a script', 'javascript:alert(1)'],
    ['a script with mixed case', 'JaVaScRiPt:alert(1)'],
    ['a script hidden by a tab', 'java\tscript:alert(1)'],
    ['a script hidden by a line break', 'https://example.com\njavascript:alert(1)'],
    ['a script behind spaces', ' javascript:alert(1)'],
    ['an encoded scheme', 'javascript&#58;alert(1)'],
    ['a percent-encoded scheme', 'javascript%3Aalert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['blob', 'blob:https://example.com/0c1d'],
    ['a file', 'file:///etc/passwd'],
    ['a VS Code command', 'command:workbench.action.terminal.new'],
    ['a VS Code link', 'vscode://file/C:/x'],
    ['a relative path', 'docs/readme.md'],
    ['a root-relative path', '/etc/passwd'],
    ['a fragment', '#section'],
    ['a protocol-relative address', '//example.com/x'],
    ['a backslash trick', 'https:\\\\example.com'],
    ['a user name', 'https://user@example.com'],
    ['a password', 'https://user:pass@example.com'],
    ['an empty string', ''],
    ['a very long address', `https://example.com/${'a'.repeat(3000)}`],
    ['a null character', 'https://example.com/\u0000'],
  ])('refuses %s', (_name, value) => {
    expect(validateLink(value)).toBe('');
  });
});
