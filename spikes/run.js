// Spike runner: node run.js <spikeDir> <35|45> [KEY=VALUE ...]
// Spawns Electron on the spike's main.js, collects `SPIKE {json}` lines, stops on `SPIKE_DONE` or timeout.
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const [spikeDir, version = '45', ...pairs] = process.argv.slice(2);
if (!spikeDir) {
  console.error('usage: node run.js <spikeDir> <35|45> [KEY=VALUE ...]');
  process.exit(2);
}
const electronPath = require(`electron-${version}`);
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0' };
for (const pair of pairs) {
  const [key, ...rest] = pair.split('=');
  env[key] = rest.join('=');
}
const timeoutMs = Number(env.SPIKE_TIMEOUT ?? 30000);
const extraArgs = (env.SPIKE_ARGS ?? '').split(' ').filter(Boolean);

const child = spawn(electronPath, [...extraArgs, path.resolve(__dirname, spikeDir)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const results = [];
let stderr = '';
const timer = setTimeout(() => {
  results.push({ spike: spikeDir, error: `TIMEOUT after ${timeoutMs}ms` });
  child.kill();
}, timeoutMs);

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.startsWith('SPIKE ')) results.push(JSON.parse(line.slice(6)));
    else if (line === 'SPIKE_DONE') child.kill();
    else if (line && env.SPIKE_VERBOSE) console.log('[app]', line);
  }
});
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const out = { spike: spikeDir, electron: version, env: Object.fromEntries(pairs.map((p) => p.split('='))), exit: code ?? signal, results };
  if (env.SPIKE_VERBOSE || results.length === 0) out.stderr = stderr.split('\n').filter((l) => !/DevTools|GPU|gpu|Fontconfig/.test(l)).slice(-15).join('\n');
  console.log(JSON.stringify(out, null, 1));
});
