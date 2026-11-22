import { describe, expect, it } from 'vitest';

import { SessionRegistry } from './session-registry.js';

describe('SessionRegistry', () => {
  it('gives control to one session and undoes its automation when it closes', () => {
    let released = 0;
    const sessions = new SessionRegistry({ onControllerClosed: () => released++ });
    const controller = sessions.open(true);
    const observer = sessions.open(true);
    expect([controller.role, observer.role]).toEqual(['controller', 'observer']);
    sessions.close(observer.sessionId);
    expect(released).toBe(0);
    sessions.close(controller.sessionId);
    expect(released).toBe(1);
    expect(sessions.open(true).role).toBe('controller');
  });

  it('works without a callback', () => {
    const sessions = new SessionRegistry();
    sessions.close(sessions.open(true).sessionId);
    expect(sessions.open(false).role).toBe('observer');
  });
});
