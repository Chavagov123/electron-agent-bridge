import { describe, expect, it } from 'vitest';

import { BridgeError } from '../errors/bridge-error.js';
import { MAX_SOCKET_PATH_BYTES, endpointDirectory, socketPath } from './discovery.js';

describe('endpointDirectory', () => {
  it('prefers XDG_RUNTIME_DIR on POSIX (already per-user)', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000/' };
    expect(endpointDirectory({ platform: 'linux', env, tmpdir: '/tmp', uid: 1000 })).toBe(
      '/run/user/1000/eab-bridge',
    );
  });

  it('falls back to a per-user directory in the shared temp dir', () => {
    expect(endpointDirectory({ platform: 'darwin', env: {}, tmpdir: '/var/tmp', uid: 501 })).toBe(
      '/var/tmp/eab-bridge-501',
    );
    expect(
      endpointDirectory({ platform: 'linux', env: { XDG_RUNTIME_DIR: '' }, tmpdir: '/tmp', uid: 7 }),
    ).toBe('/tmp/eab-bridge-7');
  });

  it('uses the per-user temp dir on Windows and ignores XDG_RUNTIME_DIR', () => {
    const dir = endpointDirectory({
      platform: 'win32',
      env: { XDG_RUNTIME_DIR: '/x' },
      tmpdir: 'C:\\Temp\\',
      uid: 1,
    });
    expect(dir).toBe('C:\\Temp\\eab-bridge');
  });
});

describe('socketPath', () => {
  it('uses a named pipe on Windows', () => {
    expect(socketPath({ platform: 'win32', directory: 'C:\\x', pid: 7, nonce: 'abc' })).toBe(
      '\\\\.\\pipe\\eab-7-abc',
    );
  });

  it('uses a socket file inside the directory on POSIX', () => {
    expect(socketPath({ platform: 'linux', directory: '/tmp/d', pid: 7, nonce: 'abc' })).toBe(
      '/tmp/d/eab-7-abc.sock',
    );
  });

  it('fits a typical macOS temp path with a 7-digit pid', () => {
    const directory = endpointDirectory({
      platform: 'darwin',
      env: {},
      tmpdir: '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/',
      uid: 501,
    });
    expect(() =>
      socketPath({ platform: 'darwin', directory, pid: 9_999_999, nonce: '0123456789abcdef' }),
    ).not.toThrow();
  });

  it('refuses paths longer than the portable sun_path limit', () => {
    const directory = `/${'d'.repeat(MAX_SOCKET_PATH_BYTES)}`;
    expect(() => socketPath({ platform: 'darwin', directory, pid: 1, nonce: 'n' })).toThrow(BridgeError);
  });
});
