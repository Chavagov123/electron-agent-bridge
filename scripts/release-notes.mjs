#!/usr/bin/env node
// Markdown notes for the GitHub release of the current version: the entries of every package's
// CHANGELOG.md section for that version (for a stable version, also its pre-releases, e.g. 1.1.0-rc.0
// for 1.1.0), each once, under its change type, plus install lines.
//
// Usage: node scripts/release-notes.mjs > notes.md
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const packages = readdirSync(join(root, 'packages')).sort();
const { version } = JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8'));
const stable = !version.includes('-');

/** type ("Minor Changes") → entries, in first-seen order. */
const byType = new Map();
const seen = new Set();

function add(type, lines) {
  const body = lines.join('\n').trim();
  // Dependency bumps between the packages say nothing to readers of the release.
  if (body === '' || body.startsWith('- Updated dependencies') || seen.has(body)) return;
  seen.add(body);
  if (!byType.has(type)) byType.set(type, []);
  byType.get(type).push(body);
}

function collect(section) {
  let type = 'Changes';
  let entry = [];
  for (const line of section.split('\n')) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      add(type, entry);
      entry = [];
      type = heading[1];
    } else if (line.startsWith('- ')) {
      add(type, entry);
      entry = [line];
    } else if (entry.length > 0) {
      entry.push(line);
    }
  }
  add(type, entry);
}

for (const dir of packages) {
  const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8');
  for (const part of text.split('\n## ').slice(1)) {
    const newline = part.indexOf('\n');
    const heading = part.slice(0, newline).trim();
    if (heading === version || (stable && heading.startsWith(`${version}-`)))
      collect(part.slice(newline + 1));
  }
}

const at = stable ? '' : `@${version.split('-')[1].split('.')[0]}`;
const lines = [
  `All \`@electron-agent-bridge/*\` packages at **${version}**.`,
  '',
  '```sh',
  `npm install --save-dev @electron-agent-bridge/electron${at} @electron-agent-bridge/mcp${at}`,
  '```',
  '',
];
for (const [type, entries] of byType) lines.push(`## ${type}`, '', ...entries, '');
lines.push('Per-package changelogs: `packages/*/CHANGELOG.md`.');
console.log(lines.join('\n'));
