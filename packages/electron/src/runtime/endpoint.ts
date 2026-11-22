import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PROTOCOL_VERSION, endpointDirectory, type Handshake } from '@eab/core';
import type { App } from 'electron';

import { FileAuditLog, NO_AUDIT, type AuditSink } from '../audit/audit-log.js';
import {
  assertPrivateDir,
  ensureEndpointDir,
  isProcessAlive,
  sweepStaleEndpoints,
} from '../control/endpoint-dir.js';
import type { HandshakeFile } from '../control/handshake-file.js';
import type { RuntimeConfig } from './config.js';

/** What the handshake needs from the host. */
export interface EndpointHost {
  readonly app: App;
  readonly electronVersion: string;
}

/** The private per-user endpoint directory, created if needed and swept of dead apps' files. */
export function prepareEndpointDir(): string {
  const uid = process.getuid?.();
  const directory = endpointDirectory({
    platform: process.platform,
    env: process.env,
    tmpdir: tmpdir(),
    ...(uid === undefined ? {} : { uid }),
  });
  ensureEndpointDir(directory);
  sweepStaleEndpoints(directory, isProcessAlive);
  return directory;
}

/** The audit log the config asks for (default: next to the endpoints). */
export function createAudit(config: RuntimeConfig, directory: string): AuditSink {
  if (config.audit === false) return NO_AUDIT;
  // A user-chosen location must be as private as the endpoint directory (docs/security.md T13).
  if (config.audit !== undefined) assertPrivateDir(dirname(config.audit));
  return new FileAuditLog({ path: config.audit ?? join(directory, `audit-${process.pid}.jsonl`) });
}

export function handshakeFor(host: EndpointHost, endpoint: string, token: string): Handshake {
  return {
    schema: 1,
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    startedAt: Date.now(),
    endpoint,
    token,
    app: { name: host.app.getName(), version: host.app.getVersion() },
    electron: host.electronVersion,
  };
}

/**
 * In Launch mode the bridge starts before Electron has read the app's package.json, so the name and
 * version are still Electron's own: write them again once the app is ready.
 */
export function refreshWhenReady(host: EndpointHost, handshake: HandshakeFile, written: Handshake): void {
  void host.app.whenReady().then(() => {
    const app = { name: host.app.getName(), version: host.app.getVersion() };
    if (app.name === written.app.name && app.version === written.app.version) return;
    try {
      handshake.update({ ...written, app });
    } catch {
      // Discovery then shows the early name; connecting is unaffected.
    }
  });
}
