'use strict';
// Electron main hosts an NDJSON JSON-RPC echo server on a named pipe (Windows) or UDS (POSIX).
const { app } = require('electron');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const out = (o) => process.stdout.write(`SPIKE ${JSON.stringify(o)}\n`);
const token = crypto.randomBytes(32).toString('hex');
const endpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\eab-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  : path.join(os.tmpdir(), `eab-${process.pid}.sock`);

app.whenReady().then(() => {
  const server = net.createServer((socket) => {
    let authed = false;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!authed) {
          authed = crypto.timingSafeEqual(Buffer.from(String(msg.token)), Buffer.from(token));
          socket.write(`${JSON.stringify({ id: msg.id, result: { authed } })}\n`);
          if (!authed) socket.end();
          continue;
        }
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.params })}\n`);
      }
    });
  });
  server.listen(endpoint, () => {
    // Client runs in plain Node (as the MCP server would).
    const client = spawn(process.env.SPIKE_NODE || 'node', [path.join(__dirname, 'client.js'), endpoint, token], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    client.stdout.on('data', (d) => { text += d; });
    client.on('exit', () => { out({ endpoint: endpoint.replace(/[0-9a-f]{12}$/, '<rand>'), platform: process.platform, ...JSON.parse(text) }); process.stdout.write('SPIKE_DONE\n'); });
  });
});
