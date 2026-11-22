import { BridgeError } from '@electron-agent-bridge/core';

/** A parsed `eab` command line. */
export interface CliArgs {
  readonly command: string | undefined;
  /** Tool input from `--key value` pairs (dotted keys nest) and `--json '{…}'`. */
  readonly input: Record<string, unknown>;
  /** Connection options (for every command but `session`, whose input `pid` is). */
  readonly pid?: number;
  /** `--observe`: connect read-only, without taking control from another client. */
  readonly role?: 'controller' | 'observer';
  /** Where to save an image result. */
  readonly out?: string;
  readonly help: boolean;
}

/** Connection options; `role` is not one of them, `find` and `act` locators use it. */
const CONNECTION_KEYS = new Set(['pid', 'observe']);

/**
 * `eab <command> [--key value]... [--json '{…}'] [--pid N] [--observe] [--out file]`.
 * Values stay strings here (the tool's schema decides their types, see `coerce`); a flag without a
 * value is `true`; `--json` is parsed as a JSON object.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [first, ...rest] = argv;
  const command = first === undefined || first.startsWith('-') ? undefined : first;
  const { json, out, ...fields } = parseOptions(command === undefined ? argv : rest);
  const parsedJson = typeof json === 'string' ? parseJson(json) : json;
  // `session` takes pid as its own input; every other command uses it to connect.
  const connection = command === 'session' ? {} : connectionOf(fields);
  const input = Object.fromEntries(
    Object.entries({ ...jsonObject(parsedJson), ...fields }).filter(
      ([key]) => command === 'session' || !CONNECTION_KEYS.has(key),
    ),
  );
  return {
    command,
    input,
    help: argv.includes('--help') || argv.includes('-h'),
    ...connection,
    ...(typeof out === 'string' ? { out } : {}),
  };
}

function parseOptions(tokens: readonly string[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (token === '--help' || token === '-h') continue;
    if (!token.startsWith('--') || token.length === 2) {
      throw new BridgeError('INVALID_PARAMS', `unexpected argument ${JSON.stringify(token)}`, {
        hint: `Pass tool input as --key value pairs or --json '{"key":"value"}'.`,
      });
    }
    const next = tokens[index + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    if (hasValue) index++;
    setPath(options, token.slice(2), hasValue ? next : true);
  }
  return options;
}

function connectionOf(fields: Record<string, unknown>): Pick<CliArgs, 'pid' | 'role'> {
  const { pid, observe } = fields;
  return {
    ...(typeof pid === 'string' && /^\d+$/.test(pid) ? { pid: Number(pid) } : {}),
    ...(observe === true ? { role: 'observer' as const } : {}),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function jsonObject(json: unknown): Record<string, unknown> {
  if (json === undefined) return {};
  if (typeof json === 'object' && json !== null && !Array.isArray(json))
    return json as Record<string, unknown>;
  throw new BridgeError('INVALID_PARAMS', '--json needs a JSON object', {
    hint: 'Quote it for your shell, e.g. --json \'{"actions":[{"type":"click","locator":{"ref":"e3"}}]}\'.',
  });
}

/** `a.b.c` → nested objects. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop() ?? path;
  let node = target;
  for (const key of keys) {
    const child = node[key];
    const next = typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : {};
    node[key] = next;
    node = next;
  }
  node[last] = value;
}
