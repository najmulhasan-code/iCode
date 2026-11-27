import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The parts of a page element that the panel script uses, and nothing more.
 * The script runs unchanged against these, so its own logic is what is tested.
 */
class FakeElement {
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  textContent = '';
  scrollTop = 0;
  readonly scrollHeight = 0;
  #parent: FakeElement | undefined;
  readonly #children: FakeElement[] = [];
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  get children(): FakeElement[] {
    return [...this.#children];
  }

  append(element: FakeElement): void {
    element.remove();
    element.#parent = this;
    this.#children.push(element);
  }

  remove(): void {
    const parent = this.#parent;
    if (parent !== undefined) {
      parent.#children.splice(parent.#children.indexOf(this), 1);
      this.#parent = undefined;
    }
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }

  click(): void {
    this.dispatch('click');
  }

  focus(): void {
    // Focus has no effect on what is tested.
  }
}

const SCRIPT = readFileSync(join(__dirname, '..', 'media', 'chat.js'), 'utf8');

/** Runs the panel script on a fake page and returns ways to act on it. */
function openPage() {
  const elements = new Map<string, FakeElement>();
  for (const id of ['messages', 'welcome', 'status', 'input', 'send', 'stop']) {
    elements.set(id, new FakeElement());
  }
  const element = (id: string): FakeElement => {
    const found = elements.get(id);
    if (found === undefined) {
      throw new Error(`no element ${id}`);
    }
    return found;
  };
  element('messages').append(element('welcome'));
  const posted: Record<string, unknown>[] = [];
  const window = new FakeElement();
  runInNewContext(SCRIPT, {
    acquireVsCodeApi: () => ({
      postMessage: (message: Record<string, unknown>) => posted.push(message),
    }),
    document: {
      getElementById: element,
      createElement: () => new FakeElement(),
    },
    window,
  });
  const input = element('input');
  return {
    posted,
    input,
    /** A message from the extension. */
    receive: (message: Record<string, unknown>) => {
      window.dispatch('message', { data: message });
    },
    /** Types a message and presses Send. Returns the request the page posted. */
    send: (text: string) => {
      input.value = text;
      input.dispatch('input');
      element('send').click();
      return posted.filter((message) => message.type === 'send').at(-1) as {
        id: number;
        chat: number;
      };
    },
    /** The text of each message shown, in order. */
    shown: () =>
      element('messages')
        .children.filter((child) => child !== element('welcome'))
        .map((child) => child.textContent),
    welcomeShown: () => !element('welcome').hidden,
  };
}

/** Shows a chat on the page, as the extension does, and returns the page's confirmation. */
let seq = 0;
function show(
  page: ReturnType<typeof openPage>,
  key: number,
  entries: unknown[] = [],
  draft = '',
  carry = false,
) {
  seq += 1;
  page.receive({ type: 'show', seq, key, entries, draft, carry });
  return page.posted.find((message) => message.type === 'switched' && message.seq === seq);
}

/** Sends a message and lets its reply end. */
function exchange(page: ReturnType<typeof openPage>, text: string, reply: string): void {
  const { id } = page.send(text);
  page.receive({ type: 'text', id, text: reply });
  page.receive({ type: 'end', id, stopReason: 'end' });
}

describe('the panel script', () => {
  it('sends nothing until it has been shown a chat', () => {
    const page = openPage();
    page.input.value = 'too early';
    page.input.dispatch('input');
    page.send('too early');

    expect(page.posted.filter((message) => message.type === 'send')).toEqual([]);
  });

  it('names the chat it shows in every message it sends', () => {
    const page = openPage();
    show(page, 1);
    exchange(page, 'hello', 'Hi.');
    show(page, 2);

    expect(page.send('again')).toMatchObject({ type: 'send', chat: 2, text: 'again' });
  });

  it('draws a chat from its entries, with the notes and errors in place', () => {
    const page = openPage();
    show(page, 1, [
      { kind: 'user', text: 'one' },
      { kind: 'reply', text: 'Partly', stopReason: 'cancelled' },
      { kind: 'user', text: 'two' },
      { kind: 'reply', text: '', stopReason: 'refusal' },
      { kind: 'user', text: 'three' },
      { kind: 'reply', text: 'Half' },
      { kind: 'error', text: 'The provider could not be reached.' },
    ]);

    expect(page.shown()).toEqual([
      'one',
      'Partly',
      'Stopped.',
      'two',
      'The model declined this request.',
      'three',
      'Half',
      'The provider could not be reached.',
    ]);
    expect(page.welcomeShown()).toBe(false);
  });

  it('reports unsent text as it changes, and confirms each switch with the text it leaves', () => {
    const page = openPage();
    expect(show(page, 1)).toEqual({ type: 'switched', seq, left: null });
    page.input.value = 'draft A';
    page.input.dispatch('input');
    expect(page.posted.at(-1)).toEqual({ type: 'draft', chat: 1, text: 'draft A' });

    expect(show(page, 2, [], 'draft B')).toEqual({
      type: 'switched',
      seq,
      left: { key: 1, draft: 'draft A' },
    });
    expect(page.input.value).toBe('draft B');
    expect(page.shown()).toEqual([]);
    expect(page.welcomeShown()).toBe(true);
  });

  it('keeps the composer text for the new chat when told to carry it', () => {
    const page = openPage();
    show(page, 1, [{ kind: 'user', text: 'topic' }]);
    page.input.value = 'carry me';

    expect(show(page, 2, [], '', true)).toMatchObject({ left: { key: 1, draft: 'carry me' } });
    expect(page.input.value).toBe('carry me');
  });

  it('takes back a message sent just before a switch, into the text it confirms for its chat', () => {
    const page = openPage();
    show(page, 1);
    exchange(page, 'first', 'One.');
    page.send('late');
    page.input.value = 'more';

    expect(show(page, 2)).toMatchObject({ left: { key: 1, draft: 'late\nmore' } });
    expect(page.shown()).toEqual([]);
  });

  it('puts a refused message back into the composer and shows why', () => {
    const page = openPage();
    show(page, 1);
    const { id } = page.send('hello');
    page.receive({ type: 'error', id, message: 'The chat is being switched.', withdraw: true });

    expect(page.input.value).toBe('hello');
    expect(page.shown()).toEqual(['The chat is being switched.']);
    expect(page.posted).toContainEqual({ type: 'draft', chat: 1, text: 'hello' });
    expect(page.posted.at(-1)).toEqual({ type: 'shown', id, text: 'The chat is being switched.' });
  });

  it('tells the extension when it takes back a message a test submitted', () => {
    const page = openPage();
    show(page, 1);
    exchange(page, 'first', 'One.');
    page.receive({ type: 'submit', text: 'from a test', token: 5 });
    show(page, 2);

    expect(page.posted).toContainEqual({ type: 'rejected', token: 5 });
  });
});
