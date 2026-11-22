/**
 * @eab/client: Programmatic Node API: connect to or launch an app, typed BridgeApi, flow runner.
 * @packageDocumentation
 */
export {
  BridgeClient,
  type CallOptions,
  type CallableMethod,
  type RpcCaller,
  type SessionInfo,
} from './api/bridge-client.js';
export { connect, type ConnectOptions } from './api/connect.js';
export {
  defaultEndpointDirectory,
  listInstances,
  readHandshake,
  type AppInstance,
} from './control/discovery.js';
export { launch, type LaunchOptions, type LaunchedApp } from './launch/launch.js';
export type { LaunchStrategy } from './launch/environment.js';
export {
  FUSE_NAMES,
  STRATEGY_FUSES,
  asarOf,
  blockedStrategies,
  fuseFileOf,
  readFuses,
  type FuseReport,
  type FuseState,
} from './launch/fuses.js';
export { parseFlow } from './flow/flow-codec.js';
export {
  flowFromRecording,
  stringifyFlow,
  type RecordedFlow,
  type RecordingToFlowOptions,
} from './flow/flow-writer.js';
export { toPlaywright, type PlaywrightExport } from './flow/playwright-export.js';
export {
  DEFAULT_STEP_TIMEOUT_MS,
  describeStep,
  runFlow,
  type FlowResult,
  type RunFlowOptions,
  type StepOutcome,
} from './flow/flow-runner.js';
export { FlowSchema, type Expectation, type Flow, type FlowApp, type FlowStep } from './flow/flow-schema.js';
export { toJunit } from './flow/junit.js';
export {
  findFlowFiles,
  runFlowFiles,
  type FlowApi,
  type RunFlowFilesOptions,
} from './flow/run-flow-files.js';
