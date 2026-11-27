import type { ChatPanelController, PanelMessage, PanelPort } from './chatPanel';

/**
 * Connects the documents a chat view loads to the controller. Each document
 * gets a number, written into its HTML, and the page puts that number on every
 * message it sends. Only the document loaded last is listened to, so a
 * document that was replaced can neither change a chat nor take the panel
 * back, however late its messages arrive.
 */
export class PageLoads {
  readonly #controller: ChatPanelController;
  readonly #post: (message: PanelMessage) => void;
  readonly #render: (load: number) => void;
  #load = 0;
  #port: PanelPort | undefined;

  /**
   * @param post Sends a message to the document shown now.
   * @param render Replaces the document with a new one that carries this number.
   */
  constructor(
    controller: ChatPanelController,
    post: (message: PanelMessage) => void,
    render: (load: number) => void,
  ) {
    this.#controller = controller;
    this.#post = post;
    this.#render = render;
  }

  /** Loads a new document. From now on, messages from earlier documents are ignored. */
  load(): void {
    this.#load += 1;
    const load = this.#load;
    const port: PanelPort = {
      post: (message) => {
        if (this.#load === load) {
          this.#post(message);
        }
      },
      // The controller asks for this when the document stopped answering.
      reload: () => {
        if (this.#load === load) {
          this.load();
        }
      },
    };
    if (this.#port !== undefined) {
      this.#controller.detach(this.#port);
    }
    this.#port = port;
    this.#render(load);
  }

  /** A message from a document. The document says when its script is running. */
  receive(message: unknown): void {
    const port = this.#port;
    if (
      port === undefined ||
      typeof message !== 'object' ||
      message === null ||
      (message as { load?: unknown }).load !== this.#load
    ) {
      return;
    }
    if ((message as { type?: unknown }).type === 'ready') {
      this.#controller.attach(port);
    } else {
      this.#controller.handle(port, message);
    }
  }

  /** The view is gone. */
  dispose(): void {
    if (this.#port !== undefined) {
      this.#controller.detach(this.#port);
      this.#port = undefined;
    }
  }
}
