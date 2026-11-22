// Same server as main.js but in plain Node, to separate Electron from the pipe itself.
const net = require('node:net');
const ep = `\\\\.\\pipe\\eab-test-${process.pid}`;
const token = 'a'.repeat(64);
net.createServer((socket) => {
  let authed = false; let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (!authed) { authed = msg.token === token; socket.write(`${JSON.stringify({ id: msg.id, result: { authed } })}\n`); if (!authed) socket.end(); continue; }
      socket.write(`${JSON.stringify({ id: msg.id, result: msg.params })}\n`);
    }
  });
}).listen(ep, () => {
  const t = Date.now();
  const c = require('node:child_process').spawn('node', [require('path').join(__dirname, 'client.js'), ep, token], { stdio: ['ignore', 'pipe', 'inherit'] });
  let o = ''; c.stdout.on('data', (d) => o += d); c.on('exit', (code) => { console.log('exit', code, Date.now() - t, 'ms', o); process.exit(0); });
});
