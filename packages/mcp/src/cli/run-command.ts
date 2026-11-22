import { existsSync } from 'node:fs';

import {
  findFlowFiles,
  runFlowFiles,
  toJunit,
  type FlowResult,
  type StepOutcome,
} from '@electron-agent-bridge/client';
import { BridgeError } from '@electron-agent-bridge/core';

import { renderError } from '../render/text.js';
import type { ClientApi } from '../session/session-manager.js';
import type { CliIo } from './io.js';

interface RunFlags {
  readonly paths: string[];
  junit?: string;
  artifacts?: string;
  pid?: number;
}

const USAGE =
  'eab run <flow file or directory>... [--junit report.xml] [--artifacts dir] [--pid N]\n' +
  'Runs YAML flows (docs/flows.md; in directories the *.flow.yaml files) and exits 0 when all pass, 1 when any fails.';

/** `eab run`: run flow files, print a report, optionally write JUnit XML. */
export async function runCommand(argv: readonly string[], api: ClientApi, io: CliIo): Promise<number> {
  let flags: RunFlags;
  let files: string[];
  try {
    flags = parseRun(argv);
    files = findFlowFiles(flags.paths);
    if (files.length === 0) throw new BridgeError('INVALID_PARAMS', 'no flow files found');
  } catch (error) {
    io.stderr(`${renderError(error)}\n\n${USAGE}`);
    return 2;
  }
  const results = await runFlowFiles(files, {
    api,
    ...(flags.pid === undefined ? {} : { pid: flags.pid }),
    ...(flags.artifacts === undefined ? {} : { artifactsDir: flags.artifacts }),
    onFlow: (file, flow) => {
      io.stdout(flow === undefined ? `\n${file}` : `\n${flow.name} (${file})`);
    },
    onStep: (step) => {
      io.stdout(renderStep(step));
    },
    // A flow that could not run at all: the reason right under its header.
    onFlowResult: (result) => {
      if (result.error === undefined) return;
      const hint = result.error.hint === undefined ? '' : `\n    Hint: ${result.error.hint}`;
      io.stdout(`  ✗ ${result.error.message}${hint}`);
    },
  });
  if (flags.junit !== undefined) io.writeFile(flags.junit, Buffer.from(toJunit(results)));
  io.stdout(`\n${summary(results)}`);
  return results.every((result) => result.passed) ? 0 : 1;
}

function parseRun(argv: readonly string[]): RunFlags {
  const flags: RunFlags = { paths: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? '';
    const value = argv[index + 1];
    if (token === '--junit' || token === '--artifacts' || token === '--pid') {
      if (value === undefined || value.startsWith('--'))
        throw new BridgeError('INVALID_PARAMS', `${token} needs a value`);
      index++;
      if (token === '--junit') flags.junit = value;
      else if (token === '--artifacts') flags.artifacts = value;
      else if (/^[1-9]\d*$/.test(value)) flags.pid = Number(value);
      else throw new BridgeError('INVALID_PARAMS', '--pid needs a process id');
    } else if (token.startsWith('-')) {
      throw new BridgeError('INVALID_PARAMS', `unknown option ${token}`);
    } else if (!existsSync(token)) {
      throw new BridgeError('INVALID_PARAMS', `no such file or directory: ${token}`);
    } else {
      flags.paths.push(token);
    }
  }
  if (flags.paths.length === 0)
    throw new BridgeError('INVALID_PARAMS', 'name at least one flow file or directory');
  return flags;
}

function renderStep(step: StepOutcome): string {
  const mark = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '-';
  const time = step.status === 'skipped' ? 'skipped' : `${Math.round(step.durationMs)} ms`;
  const lines = [`  ${mark} ${step.index + 1}. ${step.name} (${time})`];
  if (step.error) {
    lines.push(`    ${step.error.code}: ${step.error.message}`);
    if (step.error.hint !== undefined) lines.push(`    Hint: ${step.error.hint}`);
  }
  for (const file of step.artifacts) lines.push(`    → ${file}`);
  return lines.join('\n');
}

function summary(results: readonly FlowResult[]): string {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const time = results.reduce((sum, result) => sum + result.durationMs, 0);
  return `${passed} flow(s) passed, ${failed} failed (${(time / 1_000).toFixed(1)} s)`;
}
