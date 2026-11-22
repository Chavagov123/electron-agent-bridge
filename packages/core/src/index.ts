/**
 * @electron-agent-bridge/core: Shared contracts: protocol table, error codes, result envelopes, budgets and privacy helpers. Isomorphic; depends on zod only.
 * @packageDocumentation
 */
export {
  ByteRing,
  type ByteRingOptions,
  type RingEntry,
  type RingPage,
  type RingStats,
} from './budget/byte-ring.js';
export { CAPS } from './budget/caps.js';
export { estimateTokens, fitToTokens, type FittedText } from './budget/token-estimate.js';
export { ERROR_CODES, ErrorCodeSchema, type ErrorCode } from './errors/error-code.js';
export {
  BridgeError,
  BridgeErrorDataSchema,
  type BridgeErrorData,
  type BridgeErrorOptions,
} from './errors/bridge-error.js';
export {
  ActionSchema,
  ObservationsSchema,
  ResolvedElementSchema,
  StepResultSchema,
  type Action,
  type ActionType,
  type Observations,
  type ResolvedElement,
  type StepResult,
} from './model/action.js';
export { LocatorSchema, RefSchema, TargetSelectorSchema, type Locator } from './model/locator.js';
export {
  IpcEventSchema,
  LogEntrySchema,
  NetworkRecordSchema,
  type IpcEvent,
  type LogEntry,
  type NetworkRecord,
} from './model/records.js';
export {
  DetachReasonSchema,
  TargetInfoSchema,
  TargetKindSchema,
  type DetachReason,
  type TargetInfo,
  type TargetKind,
} from './model/target.js';
export { SessionRoleSchema, type SessionRole } from './protocol/methods/session.js';
export { WaitConditionSchema, type WaitCondition } from './model/wait.js';
export {
  DEFAULT_SENSITIVE_KEYS,
  REDACTED,
  isSensitiveKey,
  redact,
  type JsonValue,
  type RedactOptions,
  type Redacted,
} from './privacy/redact.js';
export {
  MAX_SCHEMA_CHARS,
  mergeShape,
  renderShape,
  shapeTreeOf,
  tupleShapeOf,
  type ShapeField,
  type ShapeNode,
} from './privacy/shape-tree.js';
export { shapeOf, type ShapeLimits } from './privacy/shape.js';
export {
  ENDPOINT_DIR_NAME,
  HandshakeSchema,
  MAX_SOCKET_PATH_BYTES,
  endpointDirectory,
  handshakeFileName,
  socketPath,
  type EndpointDirInput,
  type Handshake,
  type SocketPathInput,
} from './protocol/discovery.js';
export {
  RPC_ERROR,
  RpcRequestSchema,
  RpcResponseSchema,
  rpcError,
  rpcResult,
  type RpcErrorObject,
  type RpcRequest,
  type RpcResponse,
} from './protocol/jsonrpc.js';
export {
  CapabilitySchema,
  Methods,
  isMethodName,
  methodsAllowed,
  type Capability,
  type MethodData,
  type MethodDef,
  type MethodInput,
  type MethodName,
  type MethodParams,
} from './protocol/methods.js';
export { ConnectionModeSchema, FEATURES, type ConnectionMode, type Feature } from './protocol/method-def.js';
export { RecordedEventSchema, type RecordedEvent } from './protocol/methods/record.js';
export { LineDecoder, MAX_LINE_CHARS, encodeLine } from './protocol/ndjson.js';
export {
  LAUNCH_OPTIONS_ENV,
  LaunchBridgeOptionsSchema,
  MAX_LAUNCH_OPTIONS_BYTES,
  parseLaunchOptions,
  type LaunchBridgeOptions,
} from './protocol/launch-options.js';
export { PROTOCOL_VERSION, isProtocolCompatible, parseVersion } from './protocol/version.js';
export { LimitationSchema, envelopeSchema, ok, type Envelope, type Limitation } from './result/envelope.js';
export {
  LIMITATION_CODES,
  compactLimitations,
  droppedLimitation,
  redactedLimitation,
  truncatedLimitation,
} from './result/limitations.js';
export { anyGlobMatcher, globMatcher } from './util/glob.js';
export { jsonByteSize, utf8Length } from './util/utf8.js';
