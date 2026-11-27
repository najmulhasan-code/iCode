import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ChatEntry } from '../../src/panelProtocol';
import { CopyButton } from './copy';
import { Markdown } from './markdown';
import { type ChatState, type ChatStore, NOTE_BY_STOP_REASON } from './store';

/** One of VS Code's own icons. */
function Icon({ name, className = '' }: { name: string; className?: string }): ReactNode {
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`} />;
}

/** The logo. Its dot fades in and out while iCode is ready or working. */
function Mark({ className }: { className: string }): ReactNode {
  return (
    <svg className={`mark ${className}`} viewBox="0 0 128 128" aria-hidden="true">
      <rect className="mark-frame" width="128" height="128" rx="28" />
      <rect className="mark-dot" x="55" y="26.5" width="18" height="18" rx="4" />
      <rect className="mark-stem" x="55" y="55.5" width="18" height="46" rx="4" />
    </svg>
  );
}

export function App({ store }: { store: ChatStore }): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return state.history === null ? (
    <Chat store={store} state={state} />
  ) : (
    <History store={store} state={state} />
  );
}

// ------------------------------------------------------------------ the chat

function Chat({ store, state }: { store: ChatStore; state: ChatState }): ReactNode {
  const empty = state.entries.length === 0 && state.pending === null;
  return (
    <div className="flex h-full flex-col">
      {empty ? <Welcome /> : <Thread store={store} state={state} />}
      <Composer store={store} state={state} />
    </div>
  );
}

function Welcome(): ReactNode {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[var(--vscode-descriptionForeground)]">
      <Mark className="moving h-11 w-11" />
      <p>Describe a task</p>
    </div>
  );
}

function Thread({ store, state }: { store: ChatStore; state: ChatState }): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // Stays at the end while the reply grows, unless the person scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && atBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  });
  // Once the outcome of a request is drawn, the view reports what it shows.
  // It waits two frames, so that parts drawn after the first commit, such as
  // code blocks, are included.
  const reported = useRef<HTMLElement>(null);
  const { toReport } = state;
  useEffect(() => {
    if (toReport === null) {
      return undefined;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        store.reportShown(reported.current?.textContent ?? '');
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [store, toReport]);
  const { pending } = state;
  return (
    <div
      ref={scroller}
      className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pt-3 pb-2"
      role="log"
      aria-label="Conversation"
      aria-busy={pending !== null}
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {state.entries.map((entry, index) => (
        <Entry
          key={index}
          entry={entry}
          store={store}
          shownRef={toReport?.index === index ? reported : undefined}
        />
      ))}
      {pending !== null && (
        <>
          <UserMessage text={pending.text} />
          {pending.reply === '' ? (
            <Working />
          ) : (
            <Markdown
              text={pending.reply}
              streaming
              onOpenLink={(url) => {
                store.openLink(url);
              }}
              onCopy={(text) => store.copy(text)}
            />
          )}
        </>
      )}
    </div>
  );
}

function Entry({
  entry,
  store,
  shownRef,
}: {
  entry: ChatEntry;
  store: ChatStore;
  /** Set on the entry that shows the outcome of the request that just ended. */
  shownRef?: Ref<HTMLElement> | undefined;
}): ReactNode {
  if (entry.kind === 'user') {
    return <UserMessage text={entry.text} />;
  }
  if (entry.kind === 'error') {
    return (
      <p
        ref={shownRef as Ref<HTMLParagraphElement>}
        className="text-[var(--vscode-errorForeground)]"
      >
        {entry.text}
      </p>
    );
  }
  const note = entry.stopReason === undefined ? undefined : NOTE_BY_STOP_REASON[entry.stopReason];
  return (
    <div className="group flex flex-col gap-1">
      {entry.text !== '' && (
        <div ref={shownRef as Ref<HTMLDivElement>}>
          <Markdown
            text={entry.text}
            streaming={false}
            onCopy={(text) => store.copy(text)}
            onOpenLink={(url) => {
              store.openLink(url);
            }}
          />
        </div>
      )}
      {note !== undefined && (
        <p className="text-[var(--vscode-descriptionForeground)] italic">{note}</p>
      )}
      {entry.text !== '' && <ReplyActions text={entry.text} store={store} />}
    </div>
  );
}

function UserMessage({ text }: { text: string }): ReactNode {
  return (
    <div className="max-w-[85%] self-end rounded-xl border border-[var(--vscode-input-border,transparent)] bg-[var(--vscode-input-background)] px-3 py-1.5 break-words whitespace-pre-wrap text-[var(--vscode-input-foreground)]">
      {text}
    </div>
  );
}

function Working(): ReactNode {
  return (
    <div
      className="flex items-center gap-2 text-[var(--vscode-descriptionForeground)]"
      role="status"
    >
      <Mark className="moving h-4 w-4" />
      <span className="shimmer">Working</span>
    </div>
  );
}

/** Shown on hover under a finished reply. */
function ReplyActions({ text, store }: { text: string; store: ChatStore }): ReactNode {
  return (
    <div className="flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      <CopyButton label="Copy reply" onCopy={() => store.copy(text)} />
    </div>
  );
}

function IconButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="icon-button flex h-6 w-6 items-center justify-center rounded-md text-[var(--vscode-icon-foreground)]"
    >
      <Icon name={icon} />
    </button>
  );
}

function Composer({ store, state }: { store: ChatStore; state: ChatState }): ReactNode {
  const input = useRef<HTMLTextAreaElement>(null);
  const working = state.pending !== null;
  const canSend = !working && state.chatKey !== null && state.draft.trim() !== '';
  // The text area grows with its text, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const element = input.current;
    if (element !== null) {
      element.style.height = 'auto';
      element.style.height = `${String(Math.min(element.scrollHeight, 200))}px`;
    }
  }, [state.draft]);
  useEffect(() => {
    input.current?.focus();
  }, [state.focusComposer]);
  const placeholder =
    state.entries.length === 0 ? 'Describe a task' : 'Ask a follow-up or describe a task';
  return (
    <form
      className="px-3 pt-1 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        store.send();
      }}
    >
      <div className="composer flex flex-col gap-1 rounded-[10px] border border-[var(--vscode-input-border,var(--vscode-widget-border,transparent))] bg-[var(--vscode-input-background)] px-3 pt-2 pb-1.5">
        <textarea
          ref={input}
          rows={1}
          aria-label="Message"
          placeholder={placeholder}
          value={state.draft}
          onChange={(event) => {
            store.setDraft(event.target.value);
          }}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            // Enter sends. Shift and Enter starts a new line.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              store.send();
            }
          }}
          className="max-h-[200px] w-full resize-none bg-transparent leading-[1.45] text-[var(--vscode-input-foreground)] outline-none placeholder:text-[var(--vscode-input-placeholderForeground)]"
        />
        <div className="flex items-center justify-end">
          {working ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={() => {
                store.stop();
              }}
              className="round-button flex h-[26px] w-[26px] items-center justify-center rounded-full"
            >
              <Icon name="primitive-square" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              title="Send"
              disabled={!canSend}
              className="round-button flex h-[26px] w-[26px] items-center justify-center rounded-full"
            >
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

// ------------------------------------------------------------- the chat list

function History({ store, state }: { store: ChatStore; state: ChatState }): ReactNode {
  const history = state.history;
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    search.current?.focus();
  }, []);
  // The highlighted row stays in view as the arrow keys move it, while the
  // cursor stays in the search box.
  const highlightedKey = history?.matching[history.highlighted]?.key;
  useEffect(() => {
    if (highlightedKey !== undefined) {
      document
        .getElementById(`history-item-${String(highlightedKey)}`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedKey]);
  if (history === null) {
    return null;
  }
  const active = history.matching[history.highlighted];
  return (
    <section
      className="flex h-full flex-col"
      aria-label="Chat history"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          store.closeHistory();
        }
      }}
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--vscode-widget-border,var(--vscode-panel-border))] px-2 py-2">
        <IconButton
          label="Back to the chat"
          icon="arrow-left"
          onClick={() => {
            store.closeHistory();
          }}
        />
        <input
          ref={search}
          type="text"
          role="combobox"
          aria-label="Search chats"
          aria-controls="history-list"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={
            active === undefined ? undefined : `history-item-${String(active.key)}`
          }
          placeholder="Search chats"
          autoComplete="off"
          spellCheck={false}
          value={history.query}
          onChange={(event) => {
            store.setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            // Keys that finish a character being composed belong to the search box.
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              store.moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              store.pickHighlighted();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-[var(--vscode-input-border,transparent)] bg-[var(--vscode-input-background)] px-2 py-1 text-[var(--vscode-input-foreground)] outline-none placeholder:text-[var(--vscode-input-placeholderForeground)] focus:border-[var(--vscode-focusBorder)]"
        />
      </div>
      {history.matching.length === 0 ? (
        <p className="m-4 text-[var(--vscode-descriptionForeground)]">
          {history.items.length === 0 ? 'No chats yet.' : 'No chats match.'}
        </p>
      ) : (
        <ul
          id="history-list"
          role="listbox"
          aria-label="Chats"
          className="flex-1 overflow-y-auto py-1"
        >
          {history.matching.map((item, index) => (
            <li
              key={item.key}
              id={`history-item-${String(item.key)}`}
              role="option"
              aria-selected={index === history.highlighted}
              className="history-item flex cursor-pointer flex-col gap-0.5 px-4 py-1.5"
              onClick={() => {
                store.pick(item.key);
              }}
            >
              <span className="truncate">{item.title}</span>
              <span className="history-description text-[0.9em] text-[var(--vscode-descriptionForeground)]">
                {item.description}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
