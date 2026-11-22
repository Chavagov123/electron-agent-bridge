import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const requireFromHere = createRequire(import.meta.url);

/** The built `eab-mcp` executable (run `pnpm build` first; `pnpm test:e2e` does). */
export function mcpBinPath(): string {
  return join(dirname(requireFromHere.resolve('@eab/mcp/package.json')), 'dist', 'bin', 'eab-mcp.js');
}

/** The built `eab` CLI. */
export function eabBinPath(): string {
  return join(dirname(mcpBinPath()), 'eab.js');
}

export interface McpTestClient {
  readonly client: Client;
  /** Call a tool and return its text plus the error flag. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** Start `eab-mcp` (or `args`, e.g. `eab mcp`) over stdio exactly as an MCP host would. */
export async function startMcpClient(
  env: Readonly<Record<string, string>>,
  args: readonly string[] = [mcpBinPath()],
): Promise<McpTestClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...args],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'eab-e2e', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string }[];
      return { text: content.map((part) => part.text ?? '').join(''), isError: result.isError === true };
    },
    close: () => client.close(),
  };
}
