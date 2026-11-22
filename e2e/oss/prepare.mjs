// Fetch, install and build the pinned OSS apps (apps.json) into .oss/<name> (git-ignored).
//   node e2e/oss/prepare.mjs [name…]   → prints a JSON map name → { directory, args, ipc } or { error }
// Idempotent: an app already prepared at its pin is reused. One app failing does not stop the others.
// Needs network access, and runs the apps' own build tools: run it in CI (oss-apps workflow).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const { apps } = JSON.parse(readFileSync(join(here, 'apps.json'), 'utf8'));
const temp = join(repo, '.oss', 'tmp');
mkdirSync(temp, { recursive: true });
// Apps named on the command line, else in EAB_OSS_APPS (comma-separated), else all.
const wanted =
  process.argv.length > 2
    ? process.argv.slice(2)
    : (process.env.EAB_OSS_APPS ?? '').split(',').filter(Boolean);

// npm/npx/node are run directly or through a shell on Windows (.cmd shims); git needs no shell.
// Progress goes to stderr: stdout is the result.
const run = (command, cwd, env) => {
  if (command.length === 0) return;
  const [file, ...args] = command;
  execFileSync(file, args, {
    cwd,
    stdio: ['ignore', process.stderr, 'inherit'],
    shell: process.platform === 'win32' && file !== 'git',
    env: { ...process.env, ...env },
  });
};

function prepare(app) {
  const directory = join(repo, '.oss', app.name);
  const marker = join(directory, '.eab-prepared');
  // The marker is the whole manifest entry: a changed pin, install, setup or build prepares again.
  const recipe = JSON.stringify(app);
  if (existsSync(marker) && readFileSync(marker, 'utf8') === recipe) return directory;
  // The apps run on the harness's Electron; only a build that needs the app's own gets it.
  // Builds' temporary files (packagers extract a whole Electron) stay next to the checkouts, on the
  // repository's disk, instead of filling the system drive.
  const env = {
    TMP: temp,
    TEMP: temp,
    TMPDIR: temp,
    ...(app.electronBinary === true ? {} : { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }),
  };
  if (!existsSync(join(directory, '.git'))) {
    run(['git', 'clone', '--quiet', '--no-checkout', app.repo, directory], repo, env);
  }
  run(['git', 'fetch', '--quiet', '--depth', '1', 'origin', app.ref], directory, env);
  run(['git', 'checkout', '--quiet', '--force', app.ref], directory, env);
  run(app.install, directory, env);
  // Install scripts are skipped; Electron's own download is its install.js.
  if (app.electronBinary === true)
    run(['node', join('node_modules', 'electron', 'install.js')], directory, env);
  for (const step of app.setup ?? []) run(step, directory, env);
  run(app.build, directory, env);
  writeFileSync(marker, recipe);
  return directory;
}

// What Electron is given: a directory or an app.asar, inside the checkout. Packagers name their
// output by platform and architecture, so `${platform}` and `${arch}` are filled in.
const appPath = (app) =>
  app.app.replaceAll('${platform}', process.platform).replaceAll('${arch}', process.arch);

const prepared = {};
for (const app of apps.filter((entry) => wanted.length === 0 || wanted.includes(entry.name))) {
  try {
    prepared[app.name] = { directory: join(prepare(app), appPath(app)), args: app.args ?? [], ipc: app.ipc };
  } catch (error) {
    prepared[app.name] = { error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
}
process.stdout.write(`${JSON.stringify(prepared)}\n`);
