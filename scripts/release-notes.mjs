#!/usr/bin/env node
// Markdown notes for the GitHub release of the current version: the entries of every package's
// CHANGELOG.md section for that version, each once, under its change type, plus install lines.
//
// Usage: node scripts/release-notes.mjs > notes.md
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const packages = readdirSync(join(root, 'packages')).sort();
const { version } = JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8'));

/** type ("Minor Changes") → entries, in first-seen order. */
const byType = new Map();
const seen = new Set();
for (const dir of packages) {
  const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8');
  const start = text.indexOf(`\n## ${version}\n`);
  if (start === -1) continue;
  const rest = text.slice(start + version.length + 5);
  const section = rest.split(/\n## /, 1)[0] ?? '';
  let type = 'Changes';
  let entry = [];
  const flush = () => {
    const body = entry.join('\n').trim();
    entry = [];
    // Dependency bumps between the packages say nothing to readers of the release.
    if (body === '' || body.startsWith('- Updated dependencies') || seen.has(body)) return;
    seen.add(body);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(body);
  };
  for (const line of section.split('\n')) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      flush();
      type = heading[1];
    } else if (line.startsWith('- ')) {
      flush();
      entry.push(line);
    } else if (entry.length > 0) {
      entry.push(line);
    }
  }
  flush();
}

const pre = version.includes('-');
const at = pre ? `@${version.split('-')[1].split('.')[0]}` : '';
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
