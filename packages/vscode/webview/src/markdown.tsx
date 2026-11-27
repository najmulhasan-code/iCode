import { code } from '@streamdown/code';
import { type ReactNode, isValidElement } from 'react';
import {
  type Components,
  Streamdown,
  type StreamdownProps,
  defaultComponents,
  defaultRehypePlugins,
} from 'streamdown';
import { CopyButton } from './copy';
import { validateLink } from '../../src/links';

/**
 * How a model's Markdown is turned into the page. The rules come from the
 * independent security review of 27 November 2026:
 *
 * - Raw HTML is never rendered: the plugin that would read it is left out,
 *   so any HTML in a reply is shown as text.
 * - The sanitizer runs first, then the hardener, with images removed and
 *   blocked links turned into plain text.
 * - Only these elements survive. Images, forms, media, SVG and maths do not.
 *   The plain span is there because the hardener turns a blocked link into a
 *   span holding the link's text, and that text must stay readable.
 * - A link survives only when the shared link check accepts it. It is drawn
 *   as a link-styled control without an address to follow, so neither the
 *   page nor the editor's own link handling can open it; a click asks the
 *   extension, which checks the link again.
 * - Code blocks get iCode's own copy button, which copies through the
 *   extension and shows success only once the extension confirms it.
 */
export const ALLOWED_ELEMENTS = [
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'del',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'code',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'sup',
  'sub',
  // A blocked link becomes a plain span holding its text.
  'span',
] as const;

type RehypePlugin = NonNullable<StreamdownProps['rehypePlugins']>[number];

/** The hardener function from Streamdown's default list, without its permissive options. */
function hardener(): RehypePlugin {
  const entry = defaultRehypePlugins.harden;
  if (!Array.isArray(entry) || typeof entry[0] !== 'function') {
    throw new Error('Streamdown no longer exports the hardener as expected.');
  }
  return entry[0] as RehypePlugin;
}

const sanitize = defaultRehypePlugins.sanitize;
if (sanitize === undefined) {
  throw new Error('Streamdown no longer exports its sanitizer.');
}

export const REHYPE_PLUGINS: RehypePlugin[] = [
  sanitize,
  [
    hardener(),
    {
      allowedLinkPrefixes: ['*'],
      allowedImagePrefixes: [],
      allowedProtocols: [],
      allowDataImages: false,
      linkBlockPolicy: 'text-only',
      imageBlockPolicy: 'remove',
    },
  ] as RehypePlugin,
];

/** Keeps only links on anchors, and only links the shared check accepts. */
export function transformUrl(url: string, key: string, node: { tagName?: string }): string {
  return key === 'href' && node.tagName === 'a' ? validateLink(url) : '';
}

/** The light and dark colour themes of VS Code's own editor. */
const SHIKI_THEMES: ['light-plus', 'dark-plus'] = ['light-plus', 'dark-plus'];

export interface MarkdownProps {
  readonly text: string;
  readonly streaming: boolean;
  readonly onOpenLink: (url: string) => void;
  /** Copies text, and resolves with whether it reached the clipboard. */
  readonly onCopy: (text: string) => Promise<boolean>;
}

/** The plain text inside React children, such as the source of a code block. */
export function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => textOf(child)).join('');
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return '';
}

const DefaultCode = defaultComponents.code;

export function Markdown({ text, streaming, onOpenLink, onCopy }: MarkdownProps): ReactNode {
  const components: Components = {
    // Nothing the model wrote is spread onto the control: only the checked address.
    a: ({ href, children }) => {
      const url = typeof href === 'string' ? validateLink(href) : '';
      if (url === '') {
        return <span>{children}</span>;
      }
      const open = (event: { preventDefault(): void; stopPropagation(): void }): void => {
        event.preventDefault();
        event.stopPropagation();
        onOpenLink(url);
      };
      return (
        <span
          role="link"
          tabIndex={0}
          title={url}
          className="icode-link"
          onClick={open}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              open(event);
            }
          }}
        >
          {children}
        </span>
      );
    },
    // Code inside a sentence stays plain inline code. Streamdown sends it to the
    // block renderer below unless it has its own component.
    inlineCode: ({ children }) => <code className="icode-inline-code">{children}</code>,
    // Streamdown's code block, with iCode's copy button on top of it.
    code: (props) => {
      return (
        <div className="icode-code">
          <DefaultCode {...props} />
          {!streaming && (
            <CopyButton label="Copy code" onCopy={() => onCopy(textOf(props.children))} />
          )}
        </div>
      );
    },
  };
  return (
    <Streamdown
      className="icode-markdown"
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      parseIncompleteMarkdown
      rehypePlugins={REHYPE_PLUGINS}
      allowedElements={ALLOWED_ELEMENTS}
      unwrapDisallowed={false}
      skipHtml={false}
      urlTransform={transformUrl}
      components={components}
      controls={{ code: false, table: false, mermaid: false, image: false }}
      linkSafety={{ enabled: false }}
      plugins={{ code }}
      shikiTheme={SHIKI_THEMES}
      // Line numbers cost width a side panel does not have.
      lineNumbers={false}
    >
      {text}
    </Streamdown>
  );
}
