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
      return posted.at(-1) as { id: number; chat: number };
    },
    /** The text of each message shown, in order. */
    shown: () =>
      element('messages')
        .children.filter((child) => child !== element('welcome'))
        .map((child) => child.textContent),
    welcomeShown: () => !element('welcome').hidden,
  };
}

/** Sends a message and lets its reply end. */
function exchange(page: ReturnType<typeof openPage>, text: string, reply: string): void {
  const { id } = page.send(text);
  page.receive({ type: 'text', id, text: reply });
  page.receive({ type: 'end', id, stopReason: 'end' });
}

describe('the panel script', () => {
  it('names the conversation it shows in every message it sends', () => {
    const page = openPage();
    page.receive({ type: 'start', key: 1 });
    exchange(page, 'hello', 'Hi.');
    page.receive({ type: 'newChat', stashKey: 1, key: 2 });

    expect(page.send('again')).toMatchObject({ type: 'send', chat: 2, text: 'again' });
  });

  it('keeps the unsent text of both conversations across New Chat and Undo', () => {
    const page = openPage();
    page.receive({ type: 'start', key: 1 });
    exchange(page, 'hello', 'Hi.');
    page.input.value = 'draft A';
    page.receive({ type: 'newChat', stashKey: 1, key: 2 });
    expect(page.input.value).toBe('');
    expect(page.shown()).toEqual([]);
    expect(page.welcomeShown()).toBe(true);

    page.input.value = 'draft B';
    page.receive({ type: 'openChat', key: 1, stashKey: 2 });
    expect(page.input.value).toBe('draft A');
    expect(page.shown()).toEqual(['hello', 'Hi.']);
    expect(page.welcomeShown()).toBe(false);
    expect(page.posted.some((message) => message.type === 'dropped')).toBe(false);

    page.receive({ type: 'openChat', key: 2, stashKey: 1 });
    expect(page.input.value).toBe('draft B');
    expect(page.shown()).toEqual([]);
  });

  it('does not keep a conversation with nothing in it, and says so', () => {
    const page = openPage();
    page.receive({ type: 'start', key: 1 });
    exchange(page, 'hello', 'Hi.');
    page.receive({ type: 'newChat', stashKey: 1, key: 2 });
    page.receive({ type: 'openChat', key: 1, stashKey: 2 });

    expect(page.posted.at(-1)).toEqual({ type: 'dropped', key: 2 });
    expect(page.shown()).toEqual(['hello', 'Hi.']);
  });

  it('takes back a message sent just before a switch, into the composer of its conversation', () => {
    const page = openPage();
    page.receive({ type: 'start', key: 1 });
    exchange(page, 'first', 'One.');
    const late = page.send('late');
    page.receive({ type: 'newChat', stashKey: 1, key: 2 });
    // The extension refuses the late message, and the page is already elsewhere.
    page.receive({ type: 'error', id: late.id, message: 'The chat was switched.' });
    expect(page.shown()).toEqual([]);

    page.receive({ type: 'openChat', key: 1, stashKey: 2 });
    expect(page.shown()).toEqual(['first', 'One.']);
    expect(page.input.value).toBe('late');
  });

  it('tells the extension when it takes back a message a test submitted', () => {
    const page = openPage();
    page.receive({ type: 'start', key: 1 });
    exchange(page, 'first', 'One.');
    page.receive({ type: 'submit', text: 'from a test', token: 5 });
    page.receive({ type: 'newChat', stashKey: 1, key: 2 });

    expect(page.posted).toContainEqual({ type: 'rejected', token: 5 });
  });
});
