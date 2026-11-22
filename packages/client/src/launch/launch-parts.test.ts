import { describe, expect, it } from 'vitest';

import { diagnose } from './diagnose.js';
import { launchEnvironment, requireOption } from './environment.js';
import { inspectorUrl, isUserScript } from './inspector.js';

const base = {
  injectPath: 'C:\\Users\\Ann Lee\\eab\\inject.cjs',
  statusPath: '/tmp/s.json',
  allowPackaged: false,
} as const;

describe('launchEnvironment', () => {
  it('drops bridge leftovers from the parent, keeps the rest, and puts our --require first', () => {
    const env = launchEnvironment({
      ...base,
      strategy: 'node-options',
      parent: {
        PATH: '/bin',
        EAB_TOKEN: 'stale',
        EAB_HANDSHAKE: '/old.json',
        NODE_OPTIONS: '--max-old-space-size=4096',
        UNSET: undefined,
      },
      extra: { EAB_AUDIT: 'off', EAB_ENABLE: '0', APP_MODE: 'test' },
    });
    expect(env).toEqual({
      PATH: '/bin',
      APP_MODE: 'test',
      EAB_AUDIT: 'off',
      EAB_ENABLE: '1',
      EAB_LAUNCH_STATUS: '/tmp/s.json',
      NODE_OPTIONS: '--require "C:/Users/Ann Lee/eab/inject.cjs" --max-old-space-size=4096',
      EAB_LAUNCH_REQUIRE: '--require "C:/Users/Ann Lee/eab/inject.cjs"',
    });
  });

  it('keeps the EAB_DISABLE kill switch from the parent or the caller', () => {
    expect(
      launchEnvironment({ ...base, strategy: 'inspector', parent: { EAB_DISABLE: '1' } })['EAB_DISABLE'],
    ).toBe('1');
    const extra = launchEnvironment({
      ...base,
      strategy: 'inspector',
      parent: {},
      extra: { EAB_DISABLE: '1' },
    });
    expect(extra['EAB_DISABLE']).toBe('1');
  });

  it('adds no --require for the inspector and only allows packaged apps when asked', () => {
    const env = launchEnvironment({ ...base, allowPackaged: true, strategy: 'inspector', parent: {} });
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['EAB_ALLOW_PACKAGED']).toBe('1');
    expect(env['EAB_ALLOW_EVAL']).toBeUndefined();
    expect(env['EAB_STATE_SHIM']).toBeUndefined();
    expect(
      launchEnvironment({ ...base, strategy: 'inspector', stateShim: true, parent: {} })['EAB_STATE_SHIM'],
    ).toBe('1');
    expect(
      launchEnvironment({ ...base, strategy: 'inspector', allowEval: true, parent: {} })['EAB_ALLOW_EVAL'],
    ).toBe('1');
    // A caller's env cannot grant it behind the launcher's back.
    expect(
      launchEnvironment({ ...base, strategy: 'inspector', parent: {}, extra: { EAB_ALLOW_EVAL: '1' } })[
        'EAB_ALLOW_EVAL'
      ],
    ).toBeUndefined();
    const user = launchEnvironment({
      ...base,
      strategy: 'inspector',
      parent: {},
      extra: { NODE_OPTIONS: '--trace-warnings' },
    });
    expect(user['NODE_OPTIONS']).toBe('--trace-warnings');
  });

  it('passes runtime options as validated JSON, and never lets the caller set them through extra', () => {
    const env = launchEnvironment({
      ...base,
      strategy: 'inspector',
      parent: {},
      extra: { EAB_OPTIONS: '{"ipc":{"values":["*"]}}' },
      options: { ipc: { values: ['settings:*'] }, logs: { mainConsole: false } },
    });
    expect(JSON.parse(env['EAB_OPTIONS'] ?? '')).toEqual({
      ipc: { values: ['settings:*'] },
      logs: { mainConsole: false },
    });
    expect(
      launchEnvironment({ ...base, strategy: 'inspector', parent: {}, extra: { EAB_OPTIONS: '{}' } }),
    ).not.toHaveProperty('EAB_OPTIONS');
    expect(() =>
      launchEnvironment({ ...base, strategy: 'inspector', parent: {}, options: { bogus: 1 } as never }),
    ).toThrow();
  });

  it('quotes only paths with spaces', () => {
    expect(requireOption('/opt/eab/inject.cjs')).toBe('--require /opt/eab/inject.cjs');
    expect(requireOption('D:\\eab\\inject.cjs')).toBe('--require D:/eab/inject.cjs');
  });
});

describe('inspector helpers', () => {
  it('finds the inspector URL in the app output', () => {
    expect(inspectorUrl('Debugger listening on ws://127.0.0.1:5555/abc-1\nFor help')).toBe(
      'ws://127.0.0.1:5555/abc-1',
    );
    expect(inspectorUrl('nothing here')).toBeUndefined();
  });

  it('tells the app’s scripts from Node and Electron internals', () => {
    expect(isUserScript('file:///home/a/app/main.js')).toBe(true);
    expect(isUserScript('C:\\apps\\demo\\resources\\app.asar\\main.cjs')).toBe(true);
    expect(isUserScript('/opt/electron/resources/default_app.asar/main.js')).toBe(true);
    expect(isUserScript('node:internal/main')).toBe(false);
    expect(isUserScript('electron/js2c/browser_init')).toBe(false);
    expect(isUserScript('/opt/electron/resources/electron.asar/browser/init.js')).toBe(false);
    expect(isUserScript('/opt/app/style.css')).toBe(false);
    expect(isUserScript('')).toBe(false);
  });
});

describe('diagnose', () => {
  it('names both blocked strategies and recommends Integrated mode', () => {
    const error = diagnose(
      '/apps/demo',
      [
        { strategy: 'node-options', outcome: { kind: 'no-effect' } },
        { strategy: 'inspector', outcome: { kind: 'no-effect' } },
      ],
      'Warning: something\n',
    );
    expect(error.code).toBe('LAUNCH_BLOCKED');
    expect(error.message).toContain(
      'node-options: NODE_OPTIONS had no effect (the EnableNodeOptionsEnvironmentVariable fuse',
    );
    expect(error.message).toContain(
      'inspector: --inspect-brk was ignored (the EnableNodeCliInspectArguments fuse',
    );
    expect(error.message).toContain('App output (last lines):\nWarning: something');
    expect(error.hint).toContain("import '@eab/electron/register'");
  });

  it('reports a gate refusal as NOT_ENABLED with the allowPackaged hint', () => {
    const error = diagnose(
      '/apps/demo',
      [
        {
          strategy: 'node-options',
          outcome: { kind: 'off', reason: 'packaged app without enableAgentBridge({ allowPackaged: true })' },
        },
      ],
      '',
    );
    expect(error).toMatchObject({
      code: 'NOT_ENABLED',
      hint: expect.stringContaining('--allow-packaged') as unknown,
    });
    const other = diagnose(
      '/a',
      [{ strategy: 'inspector', outcome: { kind: 'off', reason: 'EAB_DISABLE=1 (kill switch)' } }],
      '',
    );
    expect(other.hint).toContain('EAB_*');
  });

  it('describes crashes, failures, timeouts and missing user scripts', () => {
    const error = diagnose(
      '/a',
      [
        { strategy: 'node-options', outcome: { kind: 'exited', code: 3, signal: null } },
        { strategy: 'inspector', outcome: { kind: 'no-user-script' } },
        { strategy: 'inspector', outcome: { kind: 'exited', code: null, signal: 'SIGSEGV' } },
        { strategy: 'inspector', outcome: { kind: 'failed', reason: 'socket refused' } },
        { strategy: 'inspector', outcome: { kind: 'timeout', stage: 'the handshake' } },
      ],
      '',
    );
    expect(error.message).toContain('exited before the bridge started (code 3)');
    expect(error.message).toContain('(SIGSEGV)');
    expect(error.message).toContain("never reached the app's own code");
    expect(error.message).toContain('the bridge failed to start: socket refused');
    expect(error.message).toContain('timed out waiting for the handshake');
  });
});
