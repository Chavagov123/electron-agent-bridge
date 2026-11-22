#!/usr/bin/env node
// Keep the MCP registry entry (server.json) at the version of @electron-agent-bridge/mcp.
// Runs after `changeset version` (see the `version-packages` script).
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('packages/mcp/package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));
server.version = version;
for (const entry of server.packages) {
  if (entry.identifier === '@electron-agent-bridge/mcp') entry.version = version;
}
writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json at ${version}`);
