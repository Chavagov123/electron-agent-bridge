import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';

import { LineDecoder, encodeLine } from '@eab/core';

import type { RpcSession } from './rpc-session.js';

/** Most concurrent clients one app accepts (one controller plus observers). */
export const MAX_CONNECTIONS = 8;
/** A client that has not authenticated within this window is dropped. */
export const AUTH_TIMEOUT_MS = 5_000;

export interface SocketServerDeps {
  /** Named pipe (Windows) or Unix socket path. */
  readonly path: string;
  readonly createSession: () => RpcSession;
  readonly onError: (error: unknown) => void;
}

/** NDJSON JSON-RPC over a named pipe / Unix domain socket (ADR-0001). */
export class SocketServer {
  readonly #deps: SocketServerDeps;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;

  constructor(deps: SocketServerDeps) {
    this.#deps = deps;
  }

  listen(): Promise<string> {
    const server = createServer((socket) => {
      this.#serve(socket);
    });
    server.maxConnections = MAX_CONNECTIONS;
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#deps.path, () => {
        server.off('error', reject);
        server.on('error', this.#deps.onError);
        if (process.platform !== 'win32') chmodSync(this.#deps.path, 0o600);
        resolve(this.#deps.path);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        if (process.platform !== 'win32') rmSync(this.#deps.path, { force: true });
        resolve();
      });
    });
  }

  #serve(socket: Socket): void {
    const session = this.#deps.createSession();
    const decoder = new LineDecoder();
    this.#sockets.add(socket);
    socket.setEncoding('utf8');
    const authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    socket.on('close', () => {
      clearTimeout(authTimer);
      this.#sockets.delete(socket);
      session.dispose();
    });
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) void this.#reply(socket, session, line, authTimer);
    });
  }

  async #reply(socket: Socket, session: RpcSession, line: string, authTimer: NodeJS.Timeout): Promise<void> {
    const reply = await session.handleLine(line);
    if (session.authenticated) clearTimeout(authTimer);
    if (socket.destroyed) return;
    if (reply.close) socket.end(encodeLine(reply.response));
    else socket.write(encodeLine(reply.response));
  }
}
