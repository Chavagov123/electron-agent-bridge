import { actTool } from './act.tool.js';
import { appTool } from './app.tool.js';
import { dialogsTool, evalTool } from './eval.tool.js';
import { findTool } from './find.tool.js';
import { ipcTool } from './ipc.tool.js';
import { logsTool } from './logs.tool.js';
import { networkTool } from './network.tool.js';
import { screenshotTool } from './screenshot.tool.js';
import { sessionTool } from './session.tool.js';
import { snapshotTool } from './snapshot.tool.js';
import { stateTool } from './state.tool.js';
import { targetsTool } from './targets.tool.js';
import type { ToolDefinition } from './tool.js';
import { waitForTool } from './wait-for.tool.js';

/** The tool set, in the order agents see it. */
export const TOOLS: readonly ToolDefinition[] = [
  sessionTool,
  targetsTool,
  snapshotTool,
  findTool,
  actTool,
  waitForTool,
  screenshotTool,
  logsTool,
  networkTool,
  ipcTool,
  stateTool,
  appTool,
  dialogsTool,
  evalTool,
] as readonly ToolDefinition[];
