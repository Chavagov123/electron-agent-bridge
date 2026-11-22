'use strict';
const net = require('node:net');
const [endpoint, token] = process.argv.slice(2);
const socket = net.connect(endpoint);
const pending = new Map();
let buf = '';
let id = 0;
socket.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const call = (payload) => new Promise((resolve) => { id += 1; pending.set(id, resolve); socket.write(`${JSON.stringify({ id, ...payload })}\n`); });
socket.on('connect', async () => {
  const bad = await new Promise((resolve) => {
    const s2 = net.connect(endpoint, () => s2.write(`${JSON.stringify({ id: 1, token: 'x'.repeat(64) })}\n`));
    s2.on('data', (d) => resolve(JSON.parse(String(d)).result.authed));
  });
  const auth = await call({ token });
  const samples = [];
  const payload = { method: 'snapshot.take', params: { text: 'x'.repeat(2000) } };
  for (let n = 0; n < Number(process.env.SPIKE_N || 10000); n += 1) {
    const t = process.hrtime.bigint();
    await call(payload);
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const pct = (p) => samples[Math.floor(samples.length * p)].toFixed(3);
  process.stdout.write(JSON.stringify({ wrongTokenRejected: bad === false, authed: auth.result.authed, roundTrips: samples.length, p50ms: pct(0.5), p95ms: pct(0.95), p99ms: pct(0.99) }));
  socket.end();
});
