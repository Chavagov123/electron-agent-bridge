// Probe which NODE_OPTIONS --require spellings Electron main accepts on this OS.
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const version = process.argv[2] || '45';
const registerPath = path.resolve(__dirname, 'eab-inject-deferred.cjs');
const forwardSlashes = registerPath.split(path.sep).join('/');
const options = [

  `--require ${forwardSlashes}`,
  `--require "${forwardSlashes}"`
];
for (const main of ['main-cjs-plain.cjs', 'main-esm-plain.mjs']) {
  for (const opt of options) {
    const result = spawnSync(require(`electron-${version}`), [path.resolve(__dirname, main)], {
      env: { ...process.env, NODE_OPTIONS: opt, SPIKE_VARIANT: `${main}+node-options` },
      encoding: 'utf8',
      timeout: 20000
    });
    const spike = result.stdout.split('\n').filter((l) => l.startsWith('SPIKE ')).map((l) => l.slice(6)).join(' ');
    const error = (result.stderr.match(/Error[^\n]*/) || [''])[0];
    console.log(version, main, JSON.stringify(opt).slice(0, 40), '=>', spike || '(none)', error);
  }
}
