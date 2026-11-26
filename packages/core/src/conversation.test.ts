import { describe, expect, it } from 'vitest';
import { Conversation } from './conversation.js';

describe('Conversation', () => {
  it('sends the kept turns followed by the new message', () => {
    const conversation = new Conversation();
    const first = conversation.begin('first');
    expect(first.messages).toEqual([{ role: 'user', text: 'first' }]);
    first.end('one');

    expect(conversation.begin('second').messages).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'one' },
      { role: 'user', text: 'second' },
    ]);
  });

  it('keeps nothing of a turn that ends without a reply', () => {
    const conversation = new Conversation();
    conversation.begin('first').end();

    expect(conversation.messages).toEqual([]);
    expect(conversation.begin('again').messages).toEqual([{ role: 'user', text: 'again' }]);
  });

  it.each([
    ['empty', ''],
    ['only spaces and line breaks', ' \n\t'],
  ])('keeps nothing of a turn whose reply is %s', (_name, reply) => {
    const conversation = new Conversation();
    conversation.begin('first').end(reply);

    expect(conversation.messages).toEqual([]);
  });

  it('is busy from the beginning of a turn to its end', () => {
    const conversation = new Conversation();
    expect(conversation.busy).toBe(false);
    const turn = conversation.begin('first');
    expect(conversation.busy).toBe(true);
    expect(() => conversation.begin('second')).toThrow('already in progress');
    turn.end('one');
    expect(conversation.busy).toBe(false);
  });

  it('ends a turn once: later calls change nothing', () => {
    const conversation = new Conversation();
    const turn = conversation.begin('first');
    turn.end('one');
    turn.end('two');
    turn.end();

    expect(conversation.messages).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'one' },
    ]);
  });

  it('does not let a turn that has ended end the turn after it', () => {
    const conversation = new Conversation();
    const first = conversation.begin('first');
    first.end('one');
    const second = conversation.begin('second');
    // Cleanup of the first turn arrives late.
    first.end();
    first.end('stray');

    expect(conversation.busy).toBe(true);
    expect(() => conversation.begin('third')).toThrow('already in progress');
    second.end('two');
    expect(conversation.messages).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'one' },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'two' },
    ]);
  });

  it('does not let a sent list change when later turns are kept', () => {
    const conversation = new Conversation();
    const first = conversation.begin('first');
    first.end('one');
    conversation.begin('second');

    expect(first.messages).toEqual([{ role: 'user', text: 'first' }]);
  });
});
