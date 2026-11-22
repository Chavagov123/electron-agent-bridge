import type { Capability, Feature } from '@electron-agent-bridge/core';
import type { z } from 'zod';

import type { SessionManager } from '../session/session-manager.js';

/** Everything a tool may use. */
export interface ToolContext {
  readonly sessions: SessionManager;
  /** Last snapshot cursor per page and scope, so `changesOnly` works without the agent tracking cursors. */
  readonly cursors: Map<string, string>;
}

/** Text plus optional images (screenshots). */
export interface ToolOutput {
  readonly text: string;
  readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
}

/**
 * Which input schemas are advertised (descriptions are the same in both). `compact` keeps the tool
 * list small for agents with many tools; `full` shows every field. Input is validated against the
 * full schema either way.
 */
export type ToolProfile = 'compact' | 'full';

/** One MCP tool: schema, description and a handler that returns text (errors are thrown). */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Shape;
  /** A smaller, looser schema advertised in the compact profile (default: `inputSchema`). */
  readonly compactSchema?: z.ZodRawShape;
  /** Listed only while the connected session has this capability (e.g. `eval`). */
  readonly requires?: Capability;
  /** Listed only while the connection serves this feature group (e.g. not `ipc` when attached to renderers). */
  readonly requiresFeature?: Feature;
  handle(input: z.output<z.ZodObject<Shape>>, context: ToolContext): Promise<string | ToolOutput>;
}

/** Identity helper that keeps the handler's input typed by its schema. */
export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}
