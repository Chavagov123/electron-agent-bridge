import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';

import { BridgeError } from '@electron-agent-bridge/core';

import { isConsoleProgram } from './windows-subsystem.js';

/** Bytes of the app's output kept for diagnosis. */
const TAIL_BYTES = 4_000;

/** A spawned app whose output goes to a log file (so it can outlive the launcher). */
export interface AppProcess {
  readonly pid: number;
  /** Resolves when the process exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly hasExited: () => boolean;
  /** The end of what the app printed so far (stdout and stderr together). */
  readonly outputTail: () => string;
  /** Kill the app and everything it started (Electron spawns GPU, renderer and utility processes). */
  readonly kill: () => Promise<void>;
  /** Let the launcher exit while the app keeps running. */
  readonly detach: () => void;
}

export interface SpawnRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly logPath: string;
}

/** Start the app. Rejects with `NOT_FOUND` when it cannot be started at all (bad path, no permission). */
export async function spawnApp(request: SpawnRequest): Promise<AppProcess> {
  const log = openSync(request.logPath, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(request.executable, [...request.args], {
      env: request.env,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      stdio: ['ignore', log, log],
      // POSIX: its own process group, so the whole tree can be killed at once. Windows: outside the
      // launcher's job object, which would otherwise kill the app when the launcher exits (eab launch).
      detached: true,
      // Only console programs: for a GUI app (Electron) it would keep the first window hidden.
      windowsHide: process.platform === 'win32' && isConsoleProgram(request.executable),
    });
  } finally {
    closeSync(log);
  }
  let exitedAlready = false;
  // Listeners first: an 'error' without one would crash the launcher (e.g. the MCP server).
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const done = (code: number | null, signal: string | null): void => {
      exitedAlready = true;
      resolve({ code, signal });
    };
    child.once('exit', done);
    child.once('error', () => {
      done(null, 'spawn-error');
    });
  });
  const failure = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => {
      resolve(undefined);
    });
    child.once('error', resolve);
  });
  if (failure !== undefined || child.pid === undefined) {
    throw new BridgeError(
      'NOT_FOUND',
      `could not start ${request.executable}: ${failure?.message ?? 'no process'}`,
      {
        hint: 'Check the executable path: it must exist and be executable by you.',
      },
    );
  }
  const pid = child.pid;
  return {
    pid,
    exited,
    hasExited: () => exitedAlready,
    outputTail: () => tailOf(request.logPath),
    kill: async () => {
      // POSIX: the group may outlive its leader (GPU and utility helpers), so kill it regardless.
      // Windows: taskkill finds the tree through the parent, and a dead pid may be reused.
      if (!exitedAlready || process.platform !== 'win32') killTree(pid);
      await exited;
    },
    detach: () => {
      child.unref();
    },
  };
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function tailOf(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text;
  } catch {
    return '';
  }
}
