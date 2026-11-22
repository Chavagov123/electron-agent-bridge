// Build the in-app runtime (@electron-agent-bridge/electron) as it was at an older git ref, for the compatibility test
// (an app running an older runtime, driven by the current client).
//
//   node e2e/compat/build-runtime.mjs <ref>      → prints the path of that runtime's dist/index.cjs
//
// The ref is checked out in a git worktree under .compat/ (git-ignored) and built there; a ref built
// before is reused. Needs network access for the worktree's `pnpm install` (from the shared store).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ref = process.argv[2];
if (!ref) {
  process.stderr.write('usage: node e2e/compat/build-runtime.mjs <git ref>\n');
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// pnpm is a .cmd shim on Windows, so it needs a shell; git must not get one (cmd eats `^`).
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: command === 'pnpm' && process.platform === 'win32',
  })
    .toString()
    .trim();

const sha = run('git', ['rev-parse', '--short=12', `${ref}^{commit}`], repo);
const tree = join(repo, '.compat', sha);
const runtime = join(tree, 'packages', 'electron', 'dist', 'index.cjs');
const register = join(tree, 'packages', 'electron', 'dist', 'register.cjs');
if (!existsSync(runtime) || !existsSync(register)) {
  // A worktree deleted by hand stays registered until pruned.
  run('git', ['worktree', 'prune'], repo);
  if (!existsSync(tree)) run('git', ['worktree', 'add', '--detach', tree, sha], repo);
  // Install scripts (Electron's download) are not needed to build the runtime.
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], tree);
  run('pnpm', ['run', 'gen'], tree);
  run('pnpm', ['exec', 'tsc', '-b', join('packages', 'electron')], tree);
  run('pnpm', ['--filter', '@electron-agent-bridge/electron', 'run', 'build'], tree);
}
process.stdout.write(`${runtime}\n`);
