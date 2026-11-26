import { describe, expect, it } from 'vitest';
import { Conversation } from './conversation.js';

describe('Conversation', () => {
  it('sends the kept turns followed by the new message', () => {
    const conversation = new Conversation();
    expect(conversation.begin('first')).toEqual([{ role: 'user', text: 'first' }]);
    conversation.end('one');

    expect(conversation.begin('second')).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'one' },
      { role: 'user', text: 'second' },
    ]);
  });

  it('keeps nothing of a turn that ends without a reply', () => {
    const conversation = new Conversation();
    conversation.begin('first');
    conversation.end();

    expect(conversation.messages).toEqual([]);
    expect(conversation.begin('again')).toEqual([{ role: 'user', text: 'again' }]);
  });

  it.each([
    ['empty', ''],
    ['only spaces and line breaks', ' \n\t'],
  ])('keeps nothing of a turn whose reply is %s', (_name, reply) => {
    const conversation = new Conversation();
    conversation.begin('first');
    conversation.end(reply);

    expect(conversation.messages).toEqual([]);
  });

  it('is busy from the beginning of a turn to its end', () => {
    const conversation = new Conversation();
    expect(conversation.busy).toBe(false);
    conversation.begin('first');
    expect(conversation.busy).toBe(true);
    expect(() => conversation.begin('second')).toThrow('already in progress');
    conversation.end('one');
    expect(conversation.busy).toBe(false);
  });

  it('ignores an end when no turn is in progress', () => {
    const conversation = new Conversation();
    conversation.begin('first');
    conversation.end('one');
    conversation.end('two');
    conversation.end();

    expect(conversation.messages).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'one' },
    ]);
  });

  it('does not let a sent list change when later turns are kept', () => {
    const conversation = new Conversation();
    const sent = conversation.begin('first');
    conversation.end('one');
    conversation.begin('second');

    expect(sent).toEqual([{ role: 'user', text: 'first' }]);
  });
});
