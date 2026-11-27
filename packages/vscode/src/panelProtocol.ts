import type { StopReason } from '@icode/protocol';

// The messages between the extension and the chat page, and what they carry.
// This file has no dependency on Node or on VS Code, so that the page, which
// runs in a browser, shares these types with the extension.

/** One row of the chat list in the panel. */
export interface ChatListItem {
  readonly key: number;
  readonly title: string;
  readonly description: string;
}

/**
 * One thing a chat shows, in order. A reply without a stop reason is the part
 * of a reply that was written before the request failed.
 */
export type ChatEntry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'reply'; readonly text: string; readonly stopReason?: StopReason }
  | { readonly kind: 'error'; readonly text: string };

/**
 * A message from the extension to the page. Every reply message names the
 * request it belongs to.
 */
export type PanelMessage =
  | { readonly type: 'text'; readonly id: number; readonly text: string }
  | { readonly type: 'end'; readonly id: number; readonly stopReason: StopReason }
  /**
   * With `withdraw`, the message was not sent: it was refused, or the chat
   * can no longer be continued. Its text goes back into the composer.
   */
  | {
      readonly type: 'error';
      readonly id: number;
      readonly message: string;
      readonly withdraw?: true;
    }
  | { readonly type: 'submit'; readonly text: string; readonly token: number }
  /**
   * Show this chat. The page answers with `switched`, naming `seq` and the
   * unsent text of the chat it showed until now. With `carry`, the page keeps
   * the text in its composer for this chat, instead of `draft`.
   */
  | {
      readonly type: 'show';
      readonly seq: number;
      readonly key: number;
      readonly entries: readonly ChatEntry[];
      readonly draft: string;
      readonly carry: boolean;
    }
  /** Show the chat list in the panel, in place of the chat. */
  | { readonly type: 'history'; readonly items: readonly ChatListItem[] }
  /** Move the cursor to the composer. */
  | { readonly type: 'focus' }
  /** Whether the text of copy request `id` reached the clipboard. */
  | { readonly type: 'copied'; readonly id: number; readonly ok: boolean };
