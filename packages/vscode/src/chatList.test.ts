import { describe, expect, it } from 'vitest';
import { chatDescription, chatTitle, timeAgo } from './chatList';
import type { ChatSummary } from './chatPanel';

function chat(fields: Partial<ChatSummary>): ChatSummary {
  return {
    key: 1,
    text: 'hello',
    lastUsed: 0,
    current: false,
    notSent: false,
    lost: false,
    ...fields,
  };
}

describe('chatTitle', () => {
  it('puts the text on one line', () => {
    expect(chatTitle(chat({ text: '  fix the\n\n  failing   test ' }))).toBe(
      'fix the failing test',
    );
  });

  it('cuts long text to 60 characters, marked as cut', () => {
    const title = chatTitle(chat({ text: 'a'.repeat(100) }));

    expect(title).toHaveLength(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps text of exactly 60 characters whole', () => {
    expect(chatTitle(chat({ text: 'b'.repeat(60) }))).toBe('b'.repeat(60));
  });

  it('shows an icon name as typed, not as an icon', () => {
    expect(chatTitle(chat({ text: 'what is $(alert)?' }))).toBe('what is $​(alert)?');
  });
});

describe('timeAgo', () => {
  const minute = 60_000;

  it.each([
    [0, 'just now'],
    [59_999, 'just now'],
    [minute, '1 minute ago'],
    [5 * minute, '5 minutes ago'],
    [60 * minute, '1 hour ago'],
    [23 * 60 * minute, '23 hours ago'],
    [24 * 60 * minute, '1 day ago'],
    [3 * 24 * 60 * minute, '3 days ago'],
  ])('says %i milliseconds ago is "%s"', (elapsed, words) => {
    expect(timeAgo(1_000_000_000 - elapsed, 1_000_000_000)).toBe(words);
  });
});

describe('chatDescription', () => {
  it('says when a chat was used, or that it is the current one', () => {
    expect(chatDescription(chat({ lastUsed: 0 }), 120_000)).toBe('2 minutes ago');
    expect(chatDescription(chat({ current: true }), 120_000)).toBe('current');
  });

  it('says when nothing was sent, and when a chat cannot be continued', () => {
    expect(chatDescription(chat({ current: true, notSent: true }), 0)).toBe('current, not sent');
    expect(chatDescription(chat({ lost: true }), 0)).toBe('just now, cannot be continued');
  });
});
