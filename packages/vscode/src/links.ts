/**
 * Decides whether a link from a model's reply may be opened, and returns the
 * address in its canonical form, or an empty string when it may not.
 *
 * Only web addresses over HTTPS and mail addresses are allowed. The address
 * must be written out in full: relative and protocol-relative addresses,
 * addresses with spaces, control characters or backslashes, and addresses
 * that carry a user name or password are all refused. The panel and the
 * extension both apply this check, so a link is checked when it is drawn and
 * again before anything is opened.
 */
export function validateLink(value: string): string {
  // Spaces, control characters and backslashes are how a scheme is disguised.
  if (value.length === 0 || value.length > 2048 || /[\s\\\p{Cc}]/u.test(value)) {
    return '';
  }
  const lower = value.toLowerCase();
  if (!lower.startsWith('https://') && !lower.startsWith('mailto:')) {
    return '';
  }
  let url: URL;
  try {
    // No base address: anything that is not complete on its own is refused.
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'mailto:') {
    return '';
  }
  if (url.username !== '' || url.password !== '') {
    return '';
  }
  if (url.protocol === 'https:' && url.hostname === '') {
    return '';
  }
  return url.href;
}
