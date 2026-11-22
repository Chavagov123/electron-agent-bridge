/**
 * @eab/attach: Attach mode — drive the renderers of a running Electron app over its remote debugging
 * port, with the engine in this process and no runtime inside the app.
 * @packageDocumentation
 */
export { attach, type AttachOptions } from './attach.js';
export { MAX_PAGES, POLL_MS, RemoteTargetSource, type RemoteTargetsDeps } from './remote-targets.js';
export { WebSocketCdpTransport, type SocketFactory, type SocketLike } from './websocket-transport.js';
