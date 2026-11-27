import { describe, expect, it } from 'vitest';
import { type ChatBackend, ChatPanelController, type PanelMessage } from './chatPanel';
import { PageLoads } from './pageLoads';

/** A backend whose sends never end, which is all these tests need. */
const backend: ChatBackend = {
  send: () => new Promise(() => undefined),
  cancel: () => undefined,
  setAside: () => Promise.resolve(undefined),
  resume: () => Promise.resolve(),
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A view that records what it renders and what it is sent. */
function setup(options: { confirmTimeout?: number } = {}) {
  const controller = new ChatPanelController(backend, options);
  const rendered: number[] = [];
  const posted: PanelMessage[] = [];
  const loads = new PageLoads(
    controller,
    (message) => posted.push(message),
    (load) => rendered.push(load),
  );
  loads.load();
  /** A document confirms each `show` it receives, as the real page does. */
  const confirm = (load: number, left: unknown = null) => {
    const show = posted.filter((message) => message.type === 'show').at(-1);
    loads.receive({ type: 'switched', seq: show?.type === 'show' ? show.seq : 0, left, load });
  };
  return { controller, loads, rendered, posted, confirm };
}

describe('PageLoads', () => {
  it('attaches the document that says it is ready, and only with its own number', async () => {
    const { controller, loads, rendered } = setup();
    expect(rendered).toEqual([1]);

    loads.receive({ type: 'ready' });
    loads.receive({ type: 'ready', load: 2 });
    expect(controller.isOpen).toBe(false);

    loads.receive({ type: 'ready', load: 1 });
    await settle();
    expect(controller.isOpen).toBe(true);
  });

  it('ignores every message from a document that was replaced, however late it arrives', async () => {
    const { controller, loads, rendered, posted, confirm } = setup();
    loads.receive({ type: 'ready', load: 1 });
    await settle();
    confirm(1);
    // The first chat of a controller has the key 1.
    const key = 1;

    loads.load();
    expect(rendered).toEqual([1, 2]);
    loads.receive({ type: 'ready', load: 2 });
    await settle();
    confirm(2);
    loads.receive({ type: 'draft', chat: key, text: 'from the new page', returned: [], load: 2 });

    // The old document's late messages change nothing.
    loads.receive({ type: 'draft', chat: key, text: 'stale', returned: [], load: 1 });
    loads.receive({ type: 'ready', load: 1 });
    loads.receive({ type: 'send', chat: key, id: 1, text: 'stale', draft: '', load: 1 });
    await settle();
    expect(controller.isOpen).toBe(true);
    expect(controller.chats()).toEqual([
      expect.objectContaining({ key, text: 'from the new page', notSent: true }),
    ]);
    expect(posted.filter((message) => message.type === 'error')).toEqual([]);
  });

  it('loads a new document when the controller asks, and listens only to that one', async () => {
    const { controller, loads, rendered } = setup({ confirmTimeout: 20 });
    loads.receive({ type: 'ready', load: 1 });
    // The document never confirms, so the controller asks for a new one.
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(rendered).toEqual([1, 2]);
    expect(controller.isOpen).toBe(false);
    loads.receive({ type: 'ready', load: 1 });
    await settle();
    expect(controller.isOpen).toBe(false);
    loads.receive({ type: 'ready', load: 2 });
    await settle();
    expect(controller.isOpen).toBe(true);
  });

  it('lets the controller go when the view is gone', async () => {
    const { controller, loads } = setup();
    loads.receive({ type: 'ready', load: 1 });
    await settle();
    loads.dispose();

    expect(controller.isOpen).toBe(false);
    loads.receive({ type: 'ready', load: 1 });
    await settle();
    expect(controller.isOpen).toBe(false);
  });
});
