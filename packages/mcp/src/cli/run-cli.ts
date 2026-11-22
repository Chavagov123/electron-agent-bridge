import { z } from 'zod';

import { renderError } from '../render/text.js';
import { SessionManager, type ClientApi } from '../session/session-manager.js';
import { TOOLS } from '../tools/catalogue.js';
import type { ToolContext, ToolDefinition } from '../tools/tool.js';
import { parseInput } from '../tools/validate.js';
import { parseCliArgs, type CliArgs } from './args.js';
import { coerce } from './coerce.js';
import { doctor, doctorExecutable } from './doctor.js';
import { launchCommand } from './launch-command.js';
import { exportCommand, recordCommand } from './record-command.js';
import { runCommand } from './run-command.js';
import type { CliIo } from './io.js';

export type { CliIo } from './io.js';

/** Exit codes: 0 ok, 1 the command failed, 2 the command line was wrong. */
export async function runCli(argv: readonly string[], api: ClientApi, io: CliIo): Promise<number> {
  if (argv[0] === 'launch') return launchCommand(argv.slice(1), api, io);
  if (argv[0] === 'run') return runCommand(argv.slice(1), api, io);
  if (argv[0] === 'record') return recordCommand(argv.slice(1), api, io);
  const executable = doctorTarget(argv);
  if (executable !== undefined) return doctorExecutable(executable, io);
  if (argv[0] === 'export') return exportCommand(argv.slice(1), io);
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    io.stderr(renderError(error));
    return 2;
  }
  if (args.command === undefined || args.command === 'help') {
    io.stdout(usage());
    return 0;
  }
  if (args.command === 'doctor') return doctor(api, io);
  const tool =
    args.command === 'list'
      ? TOOLS.find((t) => t.name === 'session')
      : TOOLS.find((t) => t.name === args.command);
  if (!tool) {
    io.stderr(`Unknown command ${JSON.stringify(args.command)}.\n\n${usage()}`);
    return 2;
  }
  if (args.help) {
    io.stdout(toolHelp(tool));
    return 0;
  }
  const input = args.command === 'list' ? { action: 'list' } : args.input;
  return runTool({ tool, input, args, api, io });
}

interface ToolRun {
  readonly tool: ToolDefinition;
  readonly input: Record<string, unknown>;
  readonly args: CliArgs;
  readonly api: ClientApi;
  readonly io: CliIo;
}

async function runTool({ tool, input, args, api, io }: ToolRun): Promise<number> {
  const sessions = new SessionManager(api);
  const context: ToolContext = { sessions, cursors: new Map() };
  try {
    const schema = z.object(tool.inputSchema);
    const parsed = parseInput(schema, coerce(schema, input));
    if (tool.name !== 'session') {
      await sessions.connect({
        ...(args.pid === undefined ? {} : { pid: args.pid }),
        ...(args.role === undefined ? {} : { role: args.role }),
      });
    }
    const output = await tool.handle(parsed as never, context);
    const { text, images = [] } = typeof output === 'string' ? { text: output } : output;
    // Files first: a failed write must not follow a printed result.
    const saved = images.map((image, index) => {
      const path = imagePath(
        args.out,
        `${tool.name}-${io.now()}`,
        image.mimeType,
        images.length > 1 ? index + 1 : 0,
      );
      io.writeFile(path, Buffer.from(image.data, 'base64'));
      return `Image saved to ${path}`;
    });
    io.stdout(text);
    for (const line of saved) io.stdout(line);
    return 0;
  } catch (error) {
    io.stderr(renderError(error));
    return 1;
  } finally {
    sessions.close();
  }
}

/** `--out` as given (numbered `name-2.png` when there are several), or a timestamped name. */
function imagePath(out: string | undefined, stem: string, mimeType: string, number: number): string {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  if (out === undefined) return `${stem}${number > 0 ? `-${number}` : ''}.${extension}`;
  if (number <= 1) return out;
  const dot = out.lastIndexOf('.');
  return dot > 0 ? `${out.slice(0, dot)}-${number}${out.slice(dot)}` : `${out}-${number}`;
}

function usage(): string {
  const tools = TOOLS.map((tool) => `  ${tool.name.padEnd(11)} ${firstSentence(tool.description)}`);
  return [
    "Usage: eab <command> [--key value]... [--json '{…}'] [--pid N] [--observe] [--out file]",
    '',
    'Commands:',
    '  list        Running apps with the bridge enabled.',
    '  doctor      Check that the running apps can be reached; doctor <executable>: its fuses and launch options.',
    '  launch      Start an unmodified app with the bridge injected: eab launch <exe> [--allow-packaged] [-- args].',
    '  run         Run YAML test flows: eab run <files|dirs> [--junit file] [--artifacts dir] [--pid N].',
    '  record      Record what you do in the app as a flow: eab record --out flow.yaml [--pid N] [--duration ms].',
    '  export      A flow as a Playwright test: eab export <flow.yaml> --playwright [--out file.spec.ts].',
    '  mcp         Run the MCP server over stdio (same as eab-mcp).',
    ...tools,
    '',
    'Each tool takes the input of the MCP tool of the same name; `eab <tool> --help` lists it.',
    'Example: eab act --json \'{"actions":[{"type":"click","locator":{"role":"button","name":"Save"}}]}\'',
  ].join('\n');
}

function toolHelp(tool: ToolDefinition): string {
  const fields = Object.entries(tool.inputSchema).map(([name, field]) => {
    const schema = field as z.ZodType;
    const description = schema.description === undefined ? '' : ` ${schema.description}`;
    return `  --${name}${schema.safeParse(undefined).success ? '' : ' (required)'}${description}`;
  });
  return [
    `eab ${tool.name}: ${tool.description}`,
    '',
    'Input:',
    ...(fields.length > 0 ? fields : ['  (none)']),
  ].join('\n');
}

function firstSentence(text: string): string {
  const end = text.search(/\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

/** `eab doctor <executable>`: the executable, when one is given. */
function doctorTarget(argv: readonly string[]): string | undefined {
  const [command, target] = argv;
  return command === 'doctor' && target !== undefined && !target.startsWith('--') ? target : undefined;
}
