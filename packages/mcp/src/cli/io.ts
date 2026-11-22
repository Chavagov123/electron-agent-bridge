/** What the CLI touches outside itself; injected for tests. */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Create or replace the file. */
  writeFile(path: string, data: Uint8Array): void;
  now(): number;
  /** Resolves when the user asks to stop a long-running command (Enter or Ctrl+C); absent: at once. */
  untilStopped?(): Promise<void>;
}
