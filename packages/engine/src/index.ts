/**
 * @electron-agent-bridge/engine: Transport-agnostic automation engine: targets, snapshots, actions, waits and observation.
 * @packageDocumentation
 */
export { ActionEngine, DEFAULT_ACTION_TIMEOUT_MS, type ActionEngineDeps } from './action/action-engine.js';
export { InputDriver, type ClickOptions, type MouseButton, type Point } from './action/input-driver.js';
export { parseChord, type Chord, type KeyDefinition, type ModifierKey } from './action/keys.js';
export { EngineFacade, type EngineDeps } from './api/engine-facade.js';
export { ActionObserver } from './observe/action-observer.js';
export { AgentPool } from './page/agent-pool.js';
export type { CdpEvent, CdpTransport, DetachReason, Disposable } from './ports/cdp-transport.js';
export type { Clock } from './ports/clock.js';
export type { TargetDescriptor, TargetSource } from './ports/target-source.js';
export { AGENT_WORLD, PageAgentClient, type AgentBundle } from './page/page-agent-client.js';
export { AgentSnapshotter, type SnapshotOptions } from './snapshot/agent-snapshotter.js';
export { AX_LIMIT, axNames, type AxNames } from './snapshot/ax-names.js';
export { baseName, slug, uniqueName, urlStem } from './targets/naming.js';
export { resolveTarget } from './targets/resolve-target.js';
export { TargetRegistry, type NamedTarget } from './targets/target-registry.js';
export { DEFAULT_WAIT_MS, Waiter, type WaiterDeps } from './wait/waiter.js';
export type { IpcFeed, IpcFeedItem, IpcFeedPage } from './ports/ipc-feed.js';
export { MAX_SCREENSHOT_BASE64, Screenshotter } from './page/screenshotter.js';
export { queryLogs, queryNetwork, type RecordQueryDeps } from './api/record-queries.js';
export { ConsoleCollector } from './observe/console-collector.js';
export { LazyDomain } from './observe/lazy-domain.js';
export {
  LogBook,
  MAX_LOG_STACK,
  MAX_LOG_TEXT,
  type LogPage,
  type LogQuery,
  type NewLogEntry,
} from './observe/log-book.js';
export type { LocationMapper, MappedLocation, ScriptLocation, StackMapper } from './ports/stack-mapper.js';
export { mapEntry } from './observe/map-stack.js';
export { LATE, withDeadline } from './observe/deadline.js';
export {
  ChildSessionTransport,
  ChildSessions,
  MAX_CHILDREN,
  type ChildHandler,
  type ChildTarget,
} from './targets/child-sessions.js';
export { ComponentReader } from './state/component-reader.js';
export {
  InputRecorder,
  RECORDING_BYTES,
  queryRecorded,
  type InputRecorderDeps,
  type RecordPage,
} from './record/input-recorder.js';
export {
  MAX_IN_FLIGHT,
  NetworkLog,
  type ExternalRequestEnd,
  type ExternalRequestStart,
  type NetworkLogOptions,
  type NetworkPage,
  type NetworkQuery,
} from './observe/network-log.js';
export { MAX_URL_CHARS, safeUrl } from './observe/url-privacy.js';
export { StateReader } from './state/state-reader.js';
export { StateHookInstaller } from './state/state-hook-installer.js';
