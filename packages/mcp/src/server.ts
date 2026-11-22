import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach } from '@electron-agent-bridge/attach';
import { connect, launch, listInstances } from '@electron-agent-bridge/client';
import { BridgeError, FEATURES } from '@electron-agent-bridge/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { fitOutput } from './output/fit.js';
import { FileSpill, type SpillSink } from './output/spill.js';
import { renderError } from './render/text.js';
import { SessionManager, type ClientApi } from './session/session-manager.js';
import { TOOLS } from './tools/catalogue.js';
import type { ToolContext, ToolDefinition, ToolOutput, ToolProfile } from './tools/tool.js';
import { parseInput } from './tools/validate.js';

export { TOOLS } from './tools/catalogue.js';
export { SPILL_CHARS } from './output/fit.js';

/** Version reported to MCP clients: the package version (a test keeps them equal). */
export const SERVER_VERSION = ownVersion();

/** The version in this package's package.json, found from wherever the code runs (src, dist, dist/bin). */
function ownVersion(): string {
  for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@electron-agent-bridge/mcp' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // No package.json here: keep going up.
    }
    if (dirname(directory) === directory) return '0.0.0';
  }
}

export interface BridgeMcpServerOptions {
  /** Injectable for tests; default: real discovery and sockets. */
  readonly api?: ClientApi;
  readonly profile?: ToolProfile;
  /** Let `session action=launch` grant `eval` (operator's choice, see `eab-mcp --allow-eval`). */
  readonly allowEval?: boolean;
  readonly spill?: SpillSink;
}

/** An MCP server plus the session it drives. */
export interface BridgeMcpServer {
  readonly server: McpServer;
  readonly sessions: SessionManager;
}

/**
 * Composition root of the MCP package. Tools are served with our own list/call handlers: the advertised
 * schema (compact or full) is only documentation, and every call is validated once, against the full
 * schema, with the same error format in both profiles.
 */
export function createBridgeMcpServer(options: BridgeMcpServerOptions = {}): BridgeMcpServer {
  const api = options.api ?? { connect, launch, attach, listInstances: () => listInstances() };
  const profile = options.profile ?? 'compact';
  const spill = options.spill ?? new FileSpill();
  const sessions = new SessionManager(api, { allowEval: options.allowEval ?? false });
  const context: ToolContext = { sessions, cursors: new Map() };
  const server = new McpServer(
    { name: 'electron-agent-bridge', version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );
  // No registerTool: the protocol-level handlers below replace the SDK's (which would validate with
  // the advertised schema and drop fields the compact schema does not list).
  const protocol = server.server;
  const listing = new Map(TOOLS.map((tool) => [tool.name, describeTool(tool, profile)]));
  const fullSchemas = new Map(TOOLS.map((tool) => [tool.name, z.object(tool.inputSchema)]));
  // Tools that need a capability or a feature group are listed (and callable) only while the session
  // has it. Without a session every feature counts as served, so the full list is advertised.
  const available = (): ToolDefinition[] => {
    const client = sessions.status();
    const open = client && !client.closed ? client : undefined;
    const capabilities = open?.session.capabilities ?? [];
    const features: readonly string[] = open?.session.features ?? FEATURES;
    return TOOLS.filter(
      (tool) =>
        (tool.requires === undefined || capabilities.includes(tool.requires)) &&
        (tool.requiresFeature === undefined || features.includes(tool.requiresFeature)),
    );
  };
  let listed = available()
    .map((tool) => tool.name)
    .join();

  protocol.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: available().flatMap((tool) => listing.get(tool.name) ?? []),
  }));
  protocol.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = available().find((candidate) => candidate.name === request.params.name);
    try {
      if (!tool) throw unknownTool(request.params.name);
      const input = parseInput(fullSchemas.get(tool.name) ?? z.object({}), request.params.arguments);
      return toResult(await tool.handle(input as never, context), spill);
    } catch (error) {
      return { content: [{ type: 'text', text: renderError(error) }], isError: true };
    } finally {
      const now = available()
        .map((candidate) => candidate.name)
        .join();
      if (now !== listed) {
        listed = now;
        server.sendToolListChanged();
      }
    }
  });
  return { server, sessions };
}

function describeTool(tool: ToolDefinition, profile: ToolProfile): Tool {
  const shape = profile === 'compact' ? (tool.compactSchema ?? tool.inputSchema) : tool.inputSchema;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' }) as Tool['inputSchema'],
  };
}

function unknownTool(name: string): BridgeError {
  return new BridgeError('NOT_FOUND', `unknown tool "${name}"`, {
    hint: 'List the tools again: eval and dialogs exist only while the app grants eval to this session.',
  });
}

function toResult(output: string | ToolOutput, spill: SpillSink): CallToolResult {
  const { text, images = [] } = typeof output === 'string' ? { text: output } : output;
  return {
    content: [
      { type: 'text', text: fitOutput(text, spill) },
      ...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
    ],
  };
}
