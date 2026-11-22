#!/usr/bin/env node
// Publish every package of the workspace that is not on npm yet, dependencies first.
//
// Each package is packed with pnpm (which turns `workspace:*` ranges into real versions) and the
// tarball is published with the npm CLI: in GitHub Actions npm then authenticates through trusted
// publishing (an OIDC token, no npm token) and attaches a provenance attestation.
//
// The dist-tag is the pre-release tag while `.changeset/pre.json` exists (e.g. `rc`), else `latest`.
// A package's first version on npm also gets `latest` from npm itself.
//
// Usage: node scripts/publish-packages.mjs [--dry-run]
// Prints one `published <name>@<version>` (or `exists …`) line per package.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORDER = ['core', 'page-agent', 'engine', 'electron', 'client', 'attach', 'mcp'];
const dryRun = process.argv.includes('--dry-run');
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const pre = join(root, '.changeset', 'pre.json');
const tag = existsSync(pre) ? JSON.parse(readFileSync(pre, 'utf8')).tag : 'latest';

// npm and pnpm are .cmd shims on Windows: they need a shell there.
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
    ...options,
  });

/** Whether this exact version is on the registry already (a rerun after a partial publish). */
function published(name, version) {
  try {
    return (
      run('npm', ['view', `${name}@${version}`, 'version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === version
    );
  } catch {
    return false;
  }
}

const found = readdirSync(join(root, 'packages')).sort();
const unknown = found.filter((name) => !ORDER.includes(name));
if (unknown.length > 0) throw new Error(`add these packages to ORDER: ${unknown.join(', ')}`);

const out = mkdtempSync(join(tmpdir(), 'eab-publish-'));
try {
  for (const dir of ORDER) {
    const directory = join(root, 'packages', dir);
    const {
      name,
      version,
      private: isPrivate,
    } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (isPrivate) continue;
    if (published(name, version)) {
      console.log(`exists ${name}@${version}`);
      continue;
    }
    const before = new Set(readdirSync(out));
    run('pnpm', ['pack', '--pack-destination', out], { cwd: directory });
    const tarball = readdirSync(out).find((file) => !before.has(file) && file.endsWith('.tgz'));
    if (tarball === undefined) throw new Error(`pnpm pack wrote no tarball for ${name}`);
    const args = ['publish', join(out, tarball), '--access', 'public', '--tag', tag];
    if (dryRun) args.push('--dry-run');
    else args.push('--provenance');
    run('npm', args, { stdio: 'inherit' });
    console.log(`${dryRun ? 'would publish' : 'published'} ${name}@${version} (tag ${tag})`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
