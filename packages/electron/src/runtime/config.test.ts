import { BridgeError } from '@eab/core';
import { describe, expect, it } from 'vitest';

import { readConfig } from './config.js';

describe('readConfig', () => {
  it('defaults to observe+interact, generated token, default handshake path', () => {
    expect(readConfig({}, {})).toEqual({
      token: undefined,
      handshakePath: undefined,
      capabilities: ['observe', 'interact'],
      ipcValueChannels: [],
      logMainConsole: true,
      logSources: [],
      sourceMaps: true,
      devtoolsShim: false,
      clickListeners: true,
      mode: 'integrated',
    });
    expect(readConfig({ EAB_LAUNCH_STATUS: '/tmp/status.json' }, {}).mode).toBe('launch');
  });

  it('takes a pre-shared token and handshake path from the environment', () => {
    const config = readConfig(
      { EAB_TOKEN: 'a'.repeat(32), EAB_HANDSHAKE: '/x/1.json' },
      { capabilities: ['observe'] },
    );
    expect(config).toEqual({
      token: 'a'.repeat(32),
      handshakePath: '/x/1.json',
      capabilities: ['observe'],
      ipcValueChannels: [],
      logMainConsole: true,
      logSources: [],
      sourceMaps: true,
      devtoolsShim: false,
      clickListeners: true,
      mode: 'integrated',
    });
  });

  it('takes the IPC channels whose values are recorded from the app only', () => {
    expect(readConfig({}, { ipc: { values: ['settings:*'] } }).ipcValueChannels).toEqual(['settings:*']);
    const source = { name: 'app', install: () => () => undefined };
    expect(readConfig({}, { logs: { mainConsole: false, sources: [source] } })).toMatchObject({
      logMainConsole: false,
      logSources: [source],
    });
  });

  it('rejects weak or malformed tokens', () => {
    expect(() => readConfig({ EAB_TOKEN: 'short' }, {})).toThrow(BridgeError);
    expect(() => readConfig({ EAB_TOKEN: `${'a'.repeat(20)} x` }, {})).toThrow(BridgeError);
  });
});
