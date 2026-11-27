import type { ChatSummary } from './chatPanel';

/** The longest name a chat gets in the list, in characters. */
const TITLE_LENGTH = 60;

/**
 * The name of a chat in the list: its text on one line, cut to a length that
 * fits. The editor would draw `$(name)` in a list item as an icon, so a zero
 * width space is put between its two characters to show it as typed.
 */
export function chatTitle(chat: ChatSummary): string {
  const line = chat.text.replace(/\s+/g, ' ').trim();
  const cut = line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
  return cut.replace(/\$\(/g, '$​(');
}

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;
}

/** How long ago something happened, in words. */
export function timeAgo(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return plural(minutes, 'minute');
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return plural(hours, 'hour');
  }
  return plural(Math.floor(hours / 24), 'day');
}

/** The words shown next to a chat's name: when it was used, and what state it is in. */
export function chatDescription(chat: ChatSummary, now: number): string {
  const parts = [chat.current ? 'current' : timeAgo(chat.lastUsed, now)];
  if (chat.notSent) {
    parts.push('not sent');
  }
  if (chat.lost) {
    parts.push('cannot be continued');
  }
  return parts.join(', ');
}
