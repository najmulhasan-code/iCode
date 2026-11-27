import { describe, expect, it } from 'vitest';
import { ChatStore, type PageMessage } from './store';

function open() {
  const posted: PageMessage[] = [];
  const store = new ChatStore((message) => posted.push(message));
  let seq = 0;
  return {
    store,
    posted,
    state: () => store.getState(),
    /** Shows a chat, as the extension does, and returns the page's confirmation. */
    show: (key: number, entries: unknown[] = [], draft = '', carry = false) => {
      seq += 1;
      store.receive({ type: 'show', seq, key, entries, draft, carry });
      return posted.find((message) => message.type === 'switched' && message.seq === seq);
    },
    /** Types a message into the composer and sends it. Returns the request. */
    send: (text: string) => {
      store.setDraft(text);
      store.send();
      return posted.filter((message) => message.type === 'send').at(-1) as unknown as {
        id: number;
        chat: number;
      };
    },
    /** Sends a message and lets its reply end. */
    exchange: (text: string, reply: string) => {
      store.setDraft(text);
      store.send();
      const { id } = posted.filter((message) => message.type === 'send').at(-1) as unknown as {
        id: number;
      };
      store.receive({ type: 'text', id, text: reply });
      store.receive({ type: 'end', id, stopReason: 'end' });
    },
  };
}

describe('the chat page', () => {
  it('sends nothing until it has been shown a chat', () => {
    const page = open();
    page.store.setDraft('too early');

    expect(page.store.send()).toBe(false);
    expect(page.posted).toEqual([]);
  });

  it('names the chat it shows in every message it sends, and says the composer is empty after it', () => {
    const page = open();
    page.show(1);
    page.exchange('hello', 'Hi.');
    page.show(2);

    expect(page.send('again')).toEqual({
      type: 'send',
      id: 2,
      chat: 2,
      text: 'again',
      draft: '',
      token: undefined,
    });
    expect(page.state().draft).toBe('');
  });

  it('streams a reply, then keeps the exchange and reports what it showed', () => {
    const page = open();
    page.show(1);
    const { id } = page.send('hello');
    page.store.receive({ type: 'text', id, text: '**Hi' });
    expect(page.state().pending).toMatchObject({ text: 'hello', reply: '**Hi' });
    page.store.receive({ type: 'text', id, text: '** there' });
    page.store.receive({ type: 'end', id, stopReason: 'max_tokens' });

    expect(page.state().pending).toBeNull();
    expect(page.state().entries).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'reply', text: '**Hi** there', stopReason: 'max_tokens' },
    ]);
    // What was displayed is reported by the view, once it has drawn the reply.
    expect(page.posted.some((message) => message.type === 'shown')).toBe(false);
    expect(page.state().toReport).toEqual([{ id, index: 1 }]);
    page.store.reportShown(id, 'Hi there');
    expect(page.posted.at(-1)).toEqual({ type: 'shown', id, text: 'Hi there' });
    expect(page.state().toReport).toEqual([]);
    // Each outcome is settled once.
    page.store.reportShown(id, 'again');
    page.store.reportNotShown(id);
    expect(
      page.posted.filter((message) => message.type === 'shown' || message.type === 'notShown'),
    ).toHaveLength(1);
  });

  it('keeps the outcome of each request when two end before the view reports', () => {
    const page = open();
    page.show(1);
    page.exchange('one', 'First.');
    page.exchange('two', 'Second.');

    expect(page.state().toReport).toEqual([
      { id: 1, index: 1 },
      { id: 2, index: 3 },
    ]);
    page.store.reportShown(2, 'Second.');
    page.store.reportShown(1, 'First.');
    expect(page.posted.filter((message) => message.type === 'shown')).toEqual([
      { type: 'shown', id: 2, text: 'Second.' },
      { type: 'shown', id: 1, text: 'First.' },
    ]);
  });

  it('never reports text it did not draw: a switch first settles the outcome as not displayed', () => {
    const page = open();
    page.show(1);
    const { id } = page.send('hello');
    page.store.receive({ type: 'text', id, text: '**never drawn**' });
    page.store.receive({ type: 'end', id, stopReason: 'end' });
    page.show(2);

    expect(page.posted).toContainEqual({ type: 'notShown', id });
    expect(page.posted.some((message) => message.type === 'shown')).toBe(false);
    expect(page.state().toReport).toEqual([]);
  });

  it('settles outcomes as not displayed when the chat list takes the place of the chat', () => {
    const page = open();
    page.show(1);
    page.exchange('one', 'First.');
    page.store.receive({ type: 'history', items: [] });
    expect(page.posted).toContainEqual({ type: 'notShown', id: 1 });

    // A reply that ends while the list is open cannot be drawn either.
    page.store.closeHistory();
    const { id } = page.send('two');
    page.store.receive({ type: 'history', items: [] });
    page.store.receive({ type: 'end', id, stopReason: 'end' });
    expect(page.posted).toContainEqual({ type: 'notShown', id });
    expect(page.state().toReport).toEqual([]);
  });

  it('ignores answers to any other message', () => {
    const page = open();
    page.show(1);
    page.send('hello');
    page.store.receive({ type: 'text', id: 99, text: 'not mine' });

    expect(page.state().pending?.reply).toBe('');
  });

  it('keeps the part of a reply written before a failure, and the reason', () => {
    const page = open();
    page.show(1);
    const { id } = page.send('hello');
    page.store.receive({ type: 'text', id, text: 'Half' });
    page.store.receive({ type: 'error', id, message: 'The provider could not be reached.' });

    expect(page.state().entries).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'reply', text: 'Half' },
      { kind: 'error', text: 'The provider could not be reached.' },
    ]);
  });

  it('reports unsent text as it changes, and confirms each switch with the text it leaves', () => {
    const page = open();
    expect(page.show(1)).toEqual({ type: 'switched', seq: 1, left: null });
    page.store.setDraft('draft A');
    expect(page.posted.at(-1)).toEqual({ type: 'draft', chat: 1, text: 'draft A', returned: [] });

    expect(page.show(2, [], 'draft B')).toEqual({
      type: 'switched',
      seq: 2,
      left: { key: 1, draft: 'draft A', returned: [] },
    });
    expect(page.state().draft).toBe('draft B');
    expect(page.state().entries).toEqual([]);
  });

  it('keeps the composer text for the new chat when told to carry it', () => {
    const page = open();
    page.show(1, [{ kind: 'user', text: 'topic' }]);
    page.store.setDraft('carry me');

    expect(page.show(2, [], '', true)).toMatchObject({ left: { key: 1, draft: 'carry me' } });
    expect(page.state().draft).toBe('carry me');
  });

  it('takes back a message sent just before a switch, into the text it confirms for its chat', () => {
    const page = open();
    page.show(1);
    page.exchange('first', 'One.');
    const late = page.send('late');
    page.store.setDraft('more');

    expect(page.show(2)).toMatchObject({
      left: { key: 1, draft: 'late\nmore', returned: [late.id] },
    });
    expect(page.state().pending).toBeNull();
  });

  it('puts a refused message back into the composer, shows why, and says which it put back', () => {
    const page = open();
    page.show(1);
    const { id } = page.send('hello');
    page.store.receive({
      type: 'error',
      id,
      message: 'The chat is being switched.',
      withdraw: true,
    });

    expect(page.state().draft).toBe('hello');
    expect(page.state().entries).toEqual([{ kind: 'error', text: 'The chat is being switched.' }]);
    expect(page.posted).toContainEqual({ type: 'draft', chat: 1, text: 'hello', returned: [id] });
    expect(page.state().toReport).toEqual([{ id, index: 0 }]);
  });

  it('tells the extension when it takes back or refuses a message a test submitted', () => {
    const page = open();
    page.store.receive({ type: 'submit', text: 'before any chat', token: 4 });
    expect(page.posted).toContainEqual({ type: 'rejected', token: 4 });

    page.show(1);
    page.exchange('first', 'One.');
    page.store.receive({ type: 'submit', text: 'from a test', token: 5 });
    page.show(2);
    expect(page.posted).toContainEqual({ type: 'rejected', token: 5 });
  });

  it('asks the extension to stop and to open a link', () => {
    const page = open();
    page.store.stop();
    page.store.openLink('https://example.com/');

    expect(page.posted).toEqual([
      { type: 'cancel' },
      { type: 'openLink', url: 'https://example.com/' },
    ]);
  });

  it('copies through the extension and learns whether each copy succeeded', async () => {
    const page = open();
    const first = page.store.copy('one');
    const second = page.store.copy('two');
    expect(page.posted).toEqual([
      { type: 'copy', id: 1, text: 'one' },
      { type: 'copy', id: 2, text: 'two' },
    ]);
    page.store.receive({ type: 'copied', id: 2, ok: false });
    page.store.receive({ type: 'copied', id: 1, ok: true });
    page.store.receive({ type: 'copied', id: 9, ok: true });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('ignores messages that are not objects', () => {
    const page = open();
    page.store.receive(null);
    page.store.receive('show');

    expect(page.state().chatKey).toBeNull();
  });
});

describe('the chat list in the panel', () => {
  const ITEMS = [
    { key: 3, title: 'fix the failing test', description: 'current' },
    { key: 2, title: 'explain the parser', description: '5 minutes ago' },
    { key: 1, title: 'fix the build', description: '1 hour ago' },
  ];

  function withList() {
    const page = open();
    page.show(3);
    page.store.receive({ type: 'history', items: ITEMS });
    return page;
  }

  it('takes the place of the chat, with the first row highlighted', () => {
    const { state } = withList();

    expect(state().history).toMatchObject({ matching: ITEMS, highlighted: 0 });
  });

  it('keeps only the chats whose name holds the search text', () => {
    const page = withList();
    page.store.setQuery('FIX');
    expect(page.state().history?.matching.map((item) => item.title)).toEqual([
      'fix the failing test',
      'fix the build',
    ]);

    page.store.setQuery('nothing like this');
    expect(page.state().history).toMatchObject({ matching: [], highlighted: -1 });
  });

  it('moves the highlight around the list and opens the highlighted chat', () => {
    const page = withList();
    page.store.moveHighlight(1);
    page.store.moveHighlight(1);
    page.store.moveHighlight(1);
    page.store.moveHighlight(-1);
    expect(page.state().history?.highlighted).toBe(2);

    page.store.pickHighlighted();
    expect(page.posted.at(-1)).toEqual({ type: 'open', key: 1 });
    expect(page.state().history).toBeNull();
  });

  it('opens a chat that is picked', () => {
    const page = withList();
    page.store.pick(2);

    expect(page.posted.at(-1)).toEqual({ type: 'open', key: 2 });
    expect(page.state().history).toBeNull();
  });

  it('closes without opening anything, and gives the cursor back to the composer', () => {
    const page = withList();
    const before = page.state().focusComposer;
    page.store.closeHistory();

    expect(page.state().history).toBeNull();
    expect(page.state().focusComposer).toBe(before + 1);
    expect(page.posted.some((message) => message.type === 'open')).toBe(false);
  });

  it('makes way for the composer when the extension asks for it', () => {
    const page = withList();
    page.store.receive({ type: 'focus' });

    expect(page.state().history).toBeNull();
  });

  it('closes when the extension switches the chat', () => {
    const page = withList();
    page.show(2);

    expect(page.state().history).toBeNull();
  });
});
