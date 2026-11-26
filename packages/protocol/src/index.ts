export * from './messages.js';

/**
 * Version of the message protocol spoken between the core and its clients.
 *
 * A client and a core exchange this number before any other message and
 * refuse to continue when they disagree.
 */
export const PROTOCOL_VERSION = 1;
