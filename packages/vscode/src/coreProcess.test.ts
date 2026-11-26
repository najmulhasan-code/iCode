import { afterEach, describe, expect, it } from 'vitest';
import { CoreProcess } from './coreProcess';

const cores: CoreProcess[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) {
    core.dispose();
  }
});

/** A CoreProcess that runs the built core. */
function createCore(): { core: CoreProcess; logged: string[] } {
  const logged: string[] = [];
  const core = new CoreProcess({
    corePath: require.resolve('@icode/core'),
    clientVersion: '0.0.0',
    log: (text) => logged.push(text),
    onNotification: () => undefined,
  });
  cores.push(core);
  return { core, logged };
}

describe('CoreProcess', () => {
  it('starts the core and completes the handshake', async () => {
    const { core } = createCore();
    const session = await core.session();

    expect(session.generation).toBe(1);
    // The same running core is handed out again.
    expect(await core.session()).toBe(session);
  });

  it('answers requests through the connection it hands out', async () => {
    const { core } = createCore();
    const { connection } = await core.session();

    // No model has been chosen, so the core refuses in its own words.
    await expect(connection.request('chat/send', { text: 'hi' })).rejects.toMatchObject({
      name: 'RpcError',
    });
  });

  it('does not start a core once it has been disposed', async () => {
    const { core, logged } = createCore();
    core.dispose();

    await expect(core.session()).rejects.toThrow('shutting down');
    expect(logged).toEqual([]);
  });

  it('rejects a start that is still in progress when it is disposed', async () => {
    const { core } = createCore();
    const starting = core.session();
    core.dispose();

    await expect(starting).rejects.toThrow('shutting down');
    await expect(core.session()).rejects.toThrow('shutting down');
  });

  it('rejects a request that is waiting when it is disposed', async () => {
    const { core } = createCore();
    const { connection } = await core.session();
    // The core never answers this before it is stopped.
    const waiting = connection.request('model/set', { provider: 'anthropic', apiKey: 'x' });
    core.dispose();

    await expect(
      Promise.race([waiting, connection.request('chat/send', { text: 'hi' })]),
    ).rejects.toThrow();
  });
});
