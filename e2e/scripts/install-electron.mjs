// Install extra Electron majors for the e2e harness (beyond those in e2e/package.json):
//   node e2e/scripts/install-electron.mjs 39 43 44     → .electron/<major>/node_modules/electron
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const majors = process.argv.slice(2).filter((value) => /^\d+$/.test(value));
if (majors.length === 0) {
  process.stderr.write('usage: node e2e/scripts/install-electron.mjs <major>...\n');
  process.exit(2);
}
for (const major of majors) {
  const directory = join(repo, '.electron', major);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true }));
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', `electron@${major}`], {
    cwd: directory,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
