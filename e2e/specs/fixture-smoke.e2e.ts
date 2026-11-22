import { describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { launchFixture } from '../harness/launch-fixture.js';
import { isAlive } from '../harness/process-tree.js';

describe.each(selectedVersions())('fixture harness on Electron %s', (electron) => {
  it('launches app-basic, reports ready, and tears down the whole process tree', async () => {
    const app = await launchFixture({ fixture: 'app-basic', electron, webPrefs: 'ci1-sb1-ni0' });
    try {
      expect(app.ready.fixture).toBe('app-basic');
      expect(app.ready.electron.split('.')[0]).toBe(electron);
      expect(app.ready.webPreferences).toEqual({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      });
    } finally {
      await app.dispose();
    }
    expect(isAlive(app.pid)).toBe(false);
  });

  it('rejects an invalid webPreferences combination instead of starting', async () => {
    await expect(launchFixture({ fixture: 'app-basic', electron, webPrefs: 'ci1-sb1-ni1' })).rejects.toThrow(
      /exited early/,
    );
  });
});
