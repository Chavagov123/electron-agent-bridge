import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitFor } from './wait.js';

/** A fixture's answer to a command (fixture-kit `handleCommands`). */
export interface FixtureReply {
  readonly command: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/**
 * Command channel to one fixture: the harness listens, the fixture connects to `path`
 * (passed as `EAB_FIXTURE_CONTROL`) and first says who it is (`{"hello": pid}`). Commands are lines;
 * replies are JSON lines. Several processes may connect (Launch mode spawns the app again when a
 * strategy has no effect, and the killed attempt's connection can arrive late): commands go to the
 * process asked for.
 */
export class FixtureControl {
  readonly path: string;
  readonly #server: Server;
  readonly #replies: FixtureReply[] = [];
  /** Live connections by the pid the fixture announced. */
  readonly #sockets = new Map<number, Socket>();
  #latest: Socket | undefined;

  private constructor(path: string, server: Server) {
    this.path = path;
    this.#server = server;
    server.on('connection', (socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines.filter((candidate) => candidate.trim() !== '')) {
          const message = JSON.parse(line) as FixtureReply | { hello: number };
          if ('hello' in message) {
            this.#sockets.set(message.hello, socket);
            this.#latest = socket;
          } else {
            this.#replies.push(message);
          }
        }
      });
      socket.on('close', () => {
        for (const [pid, open] of this.#sockets) if (open === socket) this.#sockets.delete(pid);
        if (this.#latest === socket) this.#latest = undefined;
      });
    });
  }

  static async listen(): Promise<FixtureControl> {
    const id = randomBytes(6).toString('hex');
    const path =
      process.platform === 'win32' ? `\\\\.\\pipe\\eab-fixture-${id}` : join(tmpdir(), `eab-fx-${id}.sock`);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    return new FixtureControl(path, server);
  }

  /** Send a command to the fixture process `pid` (default: the latest to connect) and wait for its reply. */
  async command(name: string, timeoutMs = 10_000, pid?: number): Promise<FixtureReply> {
    const socket = await waitFor(() => (pid === undefined ? this.#latest : this.#sockets.get(pid)), {
      timeoutMs,
      what: `fixture${pid === undefined ? '' : ` ${pid}`} to connect its control channel`,
    });
    const seen = this.#replies.length;
    socket.write(`${name}\n`);
    return waitFor(() => this.#replies.slice(seen).find((reply) => reply.command === name), {
      timeoutMs,
      what: `reply to ${name}`,
    });
  }

  close(): void {
    for (const socket of this.#sockets.values()) socket.destroy();
    this.#server.close();
  }
}
