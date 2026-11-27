import type { PageMessage } from './store';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * The page's one channel to the extension. Every message carries the number
 * of this copy of the page, written into its HTML by the extension, so the
 * extension can ignore a copy that was replaced.
 */
export function createBridge(): { post: (message: PageMessage) => void } {
  const vscode = acquireVsCodeApi();
  const load = Number(document.getElementById('icode-load')?.getAttribute('content'));
  const post = (message: PageMessage): void => {
    vscode.postMessage({ ...message, load });
  };
  return { post };
}
