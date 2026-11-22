/**
 * @electron-agent-bridge/mcp: MCP server (eab-mcp) and CLI (eab) on top of @electron-agent-bridge/client.
 * @packageDocumentation
 */
export { SERVER_VERSION, TOOLS, createBridgeMcpServer, type BridgeMcpServer } from './server.js';
export { SessionManager, type ClientApi } from './session/session-manager.js';
export type { ToolContext, ToolDefinition } from './tools/tool.js';
