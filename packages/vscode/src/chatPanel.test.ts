import type { StopReason } from '@icode/protocol';
import { describe, expect, it } from 'vitest';
import { type ChatBackend, ChatPanelController, type PanelMessage } from './chatPanel';

/** A chat backend the test drives: each send waits until the test ends it. */
function fakeChat() {
  const sends: {
    text: string;
    piece: (text: string) => void;
    end: (stopReason: StopReason) => void;
    fail: (message: string) => void;
  }[] = [];
  let cancels = 0;
  const backend: ChatBackend = {
    send: (text, onText) =>
      new Promise((resolve, reject) => {
        sends.push({
          text,
          piece: onText,
          end: resolve,
          fail: (message) => {
            reject(new Error(message));
          },
        });
      }),
    cancel: () => {
      cancels += 1;
    },
  };
  return { backend, sends, cancels: () => cancels };
}

function page() {
  const posted: PanelMessage[] = [];
  return { posted, post: (message: PanelMessage) => posted.push(message) };
}

/** Lets everything that is ready to run, run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const chat = fakeChat();
  const controller = new ChatPanelController(chat.backend);
  const port = page();
  controller.attach(port);
  return { ...chat, controller, port };
}

describe('a message from the page', () => {
  it('is sent, and its pieces and its end go back with the same number', async () => {
    const { controller, port, sends } = setup();
    controller.handle(port, { type: 'send', id: 7, text: '  hello  ' });

    expect(sends[0]?.text).toBe('hello');
    sends[0]?.piece('Hi');
    sends[0]?.piece(' there');
    sends[0]?.end('end');
    await settle();
    expect(port.posted).toEqual([
      { type: 'text', id: 7, text: 'Hi' },
      { type: 'text', id: 7, text: ' there' },
      { type: 'end', id: 7, stopReason: 'end' },
    ]);
  });

  it('gets the failure in words when the request fails', async () => {
    const { controller, port, sends } = setup();
    controller.handle(port, { type: 'send', id: 1, text: 'hello' });
    sends[0]?.fail('The provider rejected the API key.');
    await settle();

    expect(port.posted).toEqual([
      { type: 'error', id: 1, message: 'The provider rejected the API key.' },
    ]);
  });

  it('is answered at once when it is empty, and nothing is sent', () => {
    const { controller, port, sends } = setup();
    controller.handle(port, { type: 'send', id: 1, text: '   ' });

    expect(sends).toHaveLength(0);
    expect(port.posted).toEqual([{ type: 'error', id: 1, message: 'The message is empty.' }]);
  });

  it('is answered at once when a reply is still being written', async () => {
    const { controller, port, sends } = setup();
    controller.handle(port, { type: 'send', id: 1, text: 'first' });
    controller.handle(port, { type: 'send', id: 2, text: 'second' });

    expect(sends).toHaveLength(1);
    expect(port.posted).toEqual([
      {
        type: 'error',
        id: 2,
        message: 'A reply is still being written. Wait for it or stop it first.',
      },
    ]);
    sends[0]?.end('end');
    await settle();
    expect(port.posted.at(-1)).toEqual({ type: 'end', id: 1, stopReason: 'end' });
  });

  it.each([
    ['nothing', undefined],
    ['text', 'send'],
    ['an array', [{ type: 'send', id: 1, text: 'x' }]],
    ['an unknown type', { type: 'run', command: 'x' }],
    ['a send without a number', { type: 'send', text: 'x' }],
    ['a send whose text is not text', { type: 'send', id: 1, text: 5 }],
  ])('is ignored when it is %s', (_name, message) => {
    const { controller, port, sends } = setup();
    controller.handle(port, message);

    expect(sends).toHaveLength(0);
    expect(port.posted).toEqual([]);
  });

  it('can stop the reply, and only while one is being written', async () => {
    const { controller, port, sends, cancels } = setup();
    controller.handle(port, { type: 'cancel' });
    expect(cancels()).toBe(0);

    controller.handle(port, { type: 'send', id: 1, text: 'hello' });
    controller.handle(port, { type: 'cancel' });
    expect(cancels()).toBe(1);
    sends[0]?.end('cancelled');
    await settle();
    expect(port.posted).toEqual([{ type: 'end', id: 1, stopReason: 'cancelled' }]);
  });
});

describe('a page that closes while a reply is being written', () => {
  it('has its reply stopped, and a new page is not affected by the old reply', async () => {
    const { controller, port: first, sends, cancels } = setup();
    controller.handle(first, { type: 'send', id: 1, text: 'old question' });
    sends[0]?.piece('old ');
    controller.detach(first);
    expect(cancels()).toBe(1);

    const second = page();
    controller.attach(second);
    // The old reply winds down after the page is gone.
    sends[0]?.piece('reply');
    sends[0]?.end('cancelled');
    await settle();
    expect(second.posted).toEqual([]);
    expect(first.posted).toEqual([{ type: 'text', id: 1, text: 'old ' }]);

    controller.handle(second, { type: 'send', id: 1, text: 'new question' });
    expect(sends[1]?.text).toBe('new question');
    sends[1]?.piece('new reply');
    sends[1]?.end('end');
    await settle();
    expect(second.posted).toEqual([
      { type: 'text', id: 1, text: 'new reply' },
      { type: 'end', id: 1, stopReason: 'end' },
    ]);
  });

  it('leaves a new page able to finish: a message sent too early is answered, not left waiting', async () => {
    const { controller, port: first, sends } = setup();
    controller.handle(first, { type: 'send', id: 1, text: 'old question' });
    const second = page();
    controller.attach(second);
    controller.handle(second, { type: 'send', id: 1, text: 'too early' });

    expect(second.posted).toHaveLength(1);
    expect(second.posted[0]).toMatchObject({ type: 'error', id: 1 });
    sends[0]?.end('cancelled');
    await settle();
    controller.handle(second, { type: 'send', id: 2, text: 'now' });
    expect(sends[1]?.text).toBe('now');
  });

  it('ignores messages from the page that is gone', () => {
    const { controller, port: first, sends } = setup();
    controller.attach(page());
    controller.handle(first, { type: 'send', id: 1, text: 'from the old page' });

    expect(sends).toHaveLength(0);
  });
});

describe('submit', () => {
  /** Plays the page's script for one submission and returns what the test learns. */
  async function submitThrough(
    setupResult: ReturnType<typeof setup>,
    text: string,
    reply: (send: ReturnType<typeof fakeChat>['sends'][number]) => void,
    id: number,
  ) {
    const { controller, port, sends } = setupResult;
    const before = sends.length;
    const result = controller.submit(text);
    const request = port.posted.at(-1);
    if (request?.type !== 'submit') {
      throw new Error('no submit message was posted');
    }
    controller.handle(port, { type: 'send', id, text: request.text, token: request.token });
    const send = sends[before];
    if (send === undefined) {
      throw new Error('the message was not sent');
    }
    reply(send);
    await settle();
    const shown = port.posted
      .filter((message) => message.type === 'text' && message.id === id)
      .map((message) => (message as { text: string }).text)
      .join('');
    controller.handle(port, { type: 'shown', id, text: shown });
    return result;
  }

  it('resolves with the outcome of its own message and what the page showed', async () => {
    const context = setup();
    const first = await submitThrough(
      context,
      'one',
      (send) => {
        send.piece('first reply');
        send.end('end');
      },
      1,
    );
    const second = await submitThrough(
      context,
      'two',
      (send) => {
        send.piece('second reply');
        send.end('max_tokens');
      },
      2,
    );

    expect(first).toEqual({ text: 'first reply', stopReason: 'end', shown: 'first reply' });
    expect(second).toEqual({
      text: 'second reply',
      stopReason: 'max_tokens',
      shown: 'second reply',
    });
  });

  it('does not resolve before the page has shown the reply', async () => {
    const { controller, port, sends } = setup();
    let resolved = false;
    const result = controller.submit('hello').then((value) => {
      resolved = true;
      return value;
    });
    const request = port.posted[0] as { token: number };
    controller.handle(port, { type: 'send', id: 1, text: 'hello', token: request.token });
    sends[0]?.end('end');
    await settle();
    expect(resolved).toBe(false);

    controller.handle(port, { type: 'shown', id: 1, text: '' });
    await expect(result).resolves.toMatchObject({ stopReason: 'end' });
  });

  it.each([
    ['an empty message', '   '],
    ['a message of line breaks', '\n\n'],
  ])('answers %s at once', async (_name, text) => {
    const { controller, port } = setup();

    await expect(controller.submit(text)).resolves.toEqual({ error: 'The message is empty.' });
    expect(port.posted).toEqual([]);
  });

  it('answers at once when no page is open', async () => {
    const controller = new ChatPanelController(fakeChat().backend);

    await expect(controller.submit('hello')).resolves.toEqual({
      error: 'The chat panel is not open.',
    });
  });

  it('is answered when the page does not accept the message', async () => {
    const { controller, port } = setup();
    const result = controller.submit('hello');
    const request = port.posted[0] as { token: number };
    controller.handle(port, { type: 'rejected', token: request.token });

    await expect(result).resolves.toEqual({ error: 'The chat panel did not accept the message.' });
  });

  it('is answered when the page closes first', async () => {
    const { controller, port } = setup();
    const result = controller.submit('hello');
    controller.detach(port);

    await expect(result).resolves.toEqual({ error: 'The chat panel was closed.' });
  });
});
