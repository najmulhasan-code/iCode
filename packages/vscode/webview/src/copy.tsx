import { type ReactNode, useEffect, useState } from 'react';

type CopyState = 'idle' | 'copying' | 'copied' | 'failed';

const LABEL_BY_STATE: Record<Exclude<CopyState, 'idle'>, string> = {
  copying: 'Copying',
  copied: 'Copied',
  failed: 'Could not copy',
};

const ICON_BY_STATE: Record<CopyState, string> = {
  idle: 'copy',
  copying: 'copy',
  copied: 'check',
  failed: 'warning',
};

/**
 * A copy button that reports only what really happened: it shows a check
 * once the extension confirms the text reached the clipboard, and a warning
 * when it did not.
 */
export function CopyButton({
  label,
  onCopy,
}: {
  label: string;
  onCopy: () => Promise<boolean>;
}): ReactNode {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => {
    if (state !== 'copied' && state !== 'failed') {
      return undefined;
    }
    const timer = setTimeout(() => {
      setState('idle');
    }, 1800);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);
  const title = state === 'idle' ? label : LABEL_BY_STATE[state];
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      disabled={state === 'copying'}
      onClick={() => {
        setState('copying');
        void onCopy().then((ok) => {
          setState(ok ? 'copied' : 'failed');
        });
      }}
      className="icon-button copy-button flex h-6 w-6 items-center justify-center rounded-md text-[var(--vscode-icon-foreground)]"
    >
      <span aria-hidden="true" className={`codicon codicon-${ICON_BY_STATE[state]}`} />
    </button>
  );
}
