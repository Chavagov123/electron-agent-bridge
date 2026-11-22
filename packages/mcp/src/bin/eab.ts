/**
 * `eab`: command line for bridge-enabled Electron apps. `eab mcp` runs the MCP server over stdio;
 * every other command runs one tool against a running app and prints the result.
 * @packageDocumentation
 */
import { writeFileSync } from 'node:fs';

import { attach } from '@electron-agent-bridge/attach';
import { connect, launch, listInstances } from '@electron-agent-bridge/client';

import { runCli } from '../cli/run-cli.js';

if (process.argv[2] === 'mcp') {
  await import('./eab-mcp.js');
} else {
  process.exitCode = await runCli(
    process.argv.slice(2),
    { connect, launch, attach, listInstances: () => listInstances() },
    {
      stdout: (text) => process.stdout.write(`${text}\n`),
      stderr: (text) => process.stderr.write(`${text}\n`),
      // `--out` names the file to write: replace it if it exists.
      writeFile: (path, data) => {
        writeFileSync(path, data);
      },
      now: () => Date.now(),
      untilStopped: () =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            process.off('SIGINT', done);
            process.stdin.off('data', done);
            process.stdin.pause();
            resolve();
          };
          process.once('SIGINT', done);
          process.stdin.once('data', done);
          process.stdin.resume();
        }),
    },
  );
}
