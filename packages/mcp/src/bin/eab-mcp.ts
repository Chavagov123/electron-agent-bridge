/**
 * `eab-mcp`: MCP server over stdio. Configure it in an MCP client (e.g. `claude mcp add eab -- npx eab-mcp`).
 * @packageDocumentation
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBridgeMcpServer } from '../server.js';

const profile = process.env['EAB_TOOL_PROFILE'] === 'full' ? 'full' : 'compact';
// Only the operator who starts the server can let agents launch apps with `eval`.
const allowEval = process.argv.includes('--allow-eval');
const { server, sessions } = createBridgeMcpServer({ profile, allowEval });
const transport = new StdioServerTransport();

// However the host goes away (closed pipe, signal, crash), the session ends and an app it launched is
// killed: launched apps are detached, so nothing else would stop them.
let stopped = false;
const stop = (code: number): void => {
  if (stopped) return;
  stopped = true;
  sessions.close();
  process.exit(code);
};
transport.onclose = () => {
  stop(0);
};
process.stdin.on('end', () => {
  stop(0);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stop(0);
  });
}
process.on('exit', () => {
  sessions.close();
});
await server.connect(transport);
