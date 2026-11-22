import { describe, expect, it } from 'vitest';

import { MAX_LAUNCH_OPTIONS_BYTES, parseLaunchOptions } from './launch-options.js';

describe('parseLaunchOptions', () => {
  it('accepts the serializable runtime options', () => {
    const options = {
      ipc: { values: ['a:*'] },
      logs: { mainConsole: false },
      snapshot: { clickListeners: false },
    };
    expect(parseLaunchOptions(JSON.stringify(options))).toEqual(options);
    expect(parseLaunchOptions('{}')).toEqual({});
  });

  it('refuses malformed JSON, unknown fields and options that widen what clients may do', () => {
    expect(() => parseLaunchOptions('{')).toThrow('not valid JSON');
    expect(() => parseLaunchOptions('{"capabilities":["eval"]}')).toThrow('EAB_OPTIONS');
    expect(() => parseLaunchOptions('{"allowPackaged":true}')).toThrow();
    expect(() => parseLaunchOptions('{"ipc":{"values":[""]}}')).toThrow('ipc.values.0');
    expect(() => parseLaunchOptions(' '.repeat(MAX_LAUNCH_OPTIONS_BYTES + 1))).toThrow('longer than');
  });
});
