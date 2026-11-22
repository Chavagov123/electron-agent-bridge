'use strict';
// A utility process for the IPC fixture: echoes messages, and answers on a MessagePort it is given.
process.parentPort.on('message', (event) => {
  const [port] = event.ports;
  if (port) {
    port.on('message', (message) => port.postMessage({ pong: message.data }));
    port.start();
  }
  process.parentPort.postMessage({ echo: event.data, ports: event.ports.length });
});
