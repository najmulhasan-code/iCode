import type { ChatSummary } from './chatPanel';

/** The longest name a chat gets in the list, in characters. */
const TITLE_LENGTH = 60;

/** One row of the chat list in the panel. */
export interface ChatListItem {
  readonly key: number;
  readonly title: string;
  readonly description: string;
}

/** The name of a chat in the list: its text on one line, cut to a length that fits. */
export function chatTitle(chat: ChatSummary): string {
  const line = chat.text.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
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

/** The words shown under a chat's name: when it was used, and what state it is in. */
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

/** The rows of the chat list, in the order given. */
export function chatListItems(chats: readonly ChatSummary[], now: number): ChatListItem[] {
  return chats.map((chat) => ({
    key: chat.key,
    title: chatTitle(chat),
    description: chatDescription(chat, now),
  }));
}
