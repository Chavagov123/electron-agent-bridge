/**
 * @electron-agent-bridge/page-agent: In-page agent (isolated world) and main-world state hook. Dependency-free; built to IIFE strings.
 * @packageDocumentation
 */
export {
  createAgent,
  type AgentResult,
  type PageAgent,
  type SnapshotRequest,
  type SnapshotResponse,
} from './agent/agent.js';
export type {
  ActionTarget,
  ElementBox,
  ConditionCheck,
  ControlState,
  LiveState,
  Requirements,
  Settled,
} from './agent/action-api.js';
export type { Match } from './agent/find.js';
export { RECORD_BINDING, type RecordedAction } from './agent/record.js';
export { AGENT_SOURCE, AGENT_VERSION } from './generated/agent-source.js';
export { COMPONENT_READER_FUNCTION } from './component/component-reader.js';
export type { ComponentFramework, ComponentReadRequest, ComponentReadResult } from './component/reader.js';
export { STATE_KEY, type StateHookConfig } from './state/entry.js';
export { stateHookSource } from './state/state-hook.js';
export type {
  StateDispatchRequest,
  StateFailure,
  StateReadRequest,
  StateReadResult,
  StoreInfo,
  StoreKind,
} from './state/registry.js';
