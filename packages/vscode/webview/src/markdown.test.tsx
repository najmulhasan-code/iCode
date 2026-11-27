import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

/** Renders a reply as the page would, to its markup. */
function render(text: string): string {
  return renderToStaticMarkup(
    <Markdown
      text={text}
      streaming={false}
      onOpenLink={() => undefined}
      onCopy={() => Promise.resolve(true)}
    />,
  );
}

describe('a reply in the panel', () => {
  it('shows Markdown as formatted text', () => {
    const html = render('## The cause\n\nThe **last** token is *dropped*.\n\n- one\n- two');

    expect(html).toContain('<h2');
    // Streamdown draws bold text as its own styled element.
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain('<em>dropped</em>');
    expect(html).toContain('<li');
    expect(html).not.toContain('**');
  });

  it('keeps code inside a sentence inline, with no block and no copy button', () => {
    const html = render('Use the `json` module.\n\n- `json.load` reads a file.');

    expect(html).toMatch(/<p>Use the <code[^>]*>json<\/code> module\.<\/p>/);
    expect(html).toMatch(/<code[^>]*>json\.load<\/code> reads a file\./);
    expect(html).not.toContain('data-streamdown="code-block"');
    expect(html).not.toContain('Copy code');
  });

  it('shows a code block with its code', () => {
    const html = render('```ts\nconst x = 1 < 2;\n```');

    expect(html).toContain('const x = 1 &lt; 2;');
    expect(html).toContain('data-streamdown="code-block"');
    // iCode's own copy button, on the confirmed copy path.
    expect(html).toContain('aria-label="Copy code"');
    expect(html).not.toContain('data-streamdown="code-block-copy-button"');
  });

  it('shows code blocks and tables in full, with no height limit of their own', () => {
    const html = render('```ts\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |');

    expect(html).toContain('data-streamdown="code-block-body"');
    expect(html).toContain('data-streamdown="table"');
    expect(html).not.toMatch(/max-height:\s*\d/);
  });

  it('shows raw HTML as text, never as elements', () => {
    const html = render('Before <script>alert(1)</script> <b onclick="x()">bold</b> after');

    // The tags appear as text, escaped, and no element is made from them.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b onclick=');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<b[\s>]/i);
    expect(html).not.toMatch(/<[a-z]+[^>]*\sonclick=/i);
  });

  it.each([
    ['a Markdown image', '![a cat](https://example.com/cat.png)'],
    ['an HTML image', '<img src="https://example.com/x.png" onerror="alert(1)">'],
    ['a data image', '![x](data:image/png;base64,AAAA)'],
  ])('never shows %s', (_name, text) => {
    expect(render(text)).not.toMatch(/<img/i);
  });

  it('keeps a full https link as a link control with no address for the page to follow', () => {
    const html = render('See [the docs](https://example.com/docs).');

    expect(html).toContain('role="link"');
    expect(html).toContain('title="https://example.com/docs"');
    expect(html).not.toMatch(/href=/i);
    expect(html).not.toMatch(/<a[\s>]/i);
  });

  it.each([
    ['a script link', '[click](javascript:alert(1))'],
    ['a plain web link', '[click](http://example.com)'],
    ['a relative link', '[click](docs/readme.md)'],
    ['a protocol-relative link', '[click](//example.com)'],
    ['a file link', '[click](file:///C:/secret.txt)'],
    ['a command link', '[click](command:workbench.action.terminal.new)'],
    ['a data link', '[click](data:text/html,<b>x</b>)'],
    ['an encoded script link', '[click](javascript&#58;alert(1))'],
  ])('turns %s into plain text', (_name, text) => {
    const html = render(text);

    expect(html).not.toMatch(/<a /i);
    expect(html).not.toMatch(/href=/i);
    expect(html).not.toContain('role="link"');
    expect(html).toContain('click');
  });
});
