import { BridgeError } from '@eab/core';
import { LineCounter, isNode, parseDocument, type Document } from 'yaml';
import { z } from 'zod';

import { EXPECTATIONS, FlowSchema, STEPS, type Flow, type FlowStep, type StepKind } from './flow-schema.js';

const STEP_KINDS = Object.keys(STEPS) as StepKind[];
const EXPECT_KINDS = Object.keys(EXPECTATIONS) as (keyof typeof EXPECTATIONS)[];
const ENV_REFERENCE = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

type Path = readonly (string | number)[];

/**
 * Parse a flow file (YAML or JSON). `${env.NAME}` in any string is replaced from `env` (a missing
 * variable is an error). Problems are reported as `file:line: steps[2].act.locator: …`.
 */
export function parseFlow(
  text: string,
  options: { readonly file?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {},
): Flow {
  const file = options.file ?? 'flow';
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const [syntax] = document.errors;
  if (syntax) {
    const at = lines.linePos(syntax.pos[0]);
    throw invalid(`${file}:${at.line}: ${syntax.message.split('\n')[0] ?? 'invalid YAML'}`);
  }
  const where = (path: Path): string => `${file}${lineOf(document, lines, path)}`;
  const raw = interpolate(document.toJS() as unknown, options.env ?? {}, [], where);
  // The flow's own fields first; then each step against the schema of its kind (precise errors).
  const top = FlowSchema.extend({ steps: z.array(z.unknown()).min(1).max(500) }).safeParse(raw);
  if (!top.success) throw fromIssues(top.error, [], where);
  const steps = top.data.steps.map((step, index) => parseStep(step, ['steps', index], where));
  return { ...top.data, steps };
}

function parseStep(raw: unknown, path: Path, where: (path: Path) => string): FlowStep {
  const kinds = kindsOf(raw, STEP_KINDS);
  if (kinds.length !== 1) {
    throw invalid(
      `${where(path)}: ${formatPath(path)}: a step needs exactly one of ${STEP_KINDS.join(', ')}` +
        (kinds.length > 1 ? ` (found ${kinds.join(' and ')})` : ''),
    );
  }
  const [kind] = kinds;
  if (kind === undefined) throw invalid(`${where(path)}: ${formatPath(path)}: empty step`);
  if (kind === 'expect') {
    const expectation = (raw as { expect: unknown }).expect;
    // `state` is also an option of the `element` check: with `element`, that is the check.
    const found = kindsOf(expectation, EXPECT_KINDS);
    const checks: (keyof typeof EXPECTATIONS)[] = found.includes('element') ? ['element'] : found;
    if (checks.length !== 1) {
      throw invalid(
        `${where([...path, 'expect'])}: ${formatPath([...path, 'expect'])}: expect one of ${EXPECT_KINDS.join(', ')}`,
      );
    }
    const [checkKind] = checks;
    if (checkKind === undefined) throw invalid(`${where(path)}: ${formatPath(path)}: empty expect`);
    const check = EXPECTATIONS[checkKind].safeParse(expectation);
    if (!check.success) throw fromIssues(check.error, [...path, 'expect'], where);
    // The common fields (name, target, …) against the step schema without its `expect`.
    const rest = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== 'expect'),
    );
    const common = STEPS.reset.omit({ reset: true }).safeParse(rest);
    if (!common.success) throw fromIssues(common.error, path, where);
    return { ...common.data, expect: check.data };
  }
  const parsed = STEPS[kind].safeParse(raw);
  if (!parsed.success) throw fromIssues(parsed.error, path, where);
  return parsed.data;
}

function kindsOf<K extends string>(raw: unknown, kinds: readonly K[]): K[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return kinds.filter((kind) => kind in raw);
}

function interpolate(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  path: Path,
  where: (path: Path) => string,
): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REFERENCE, (_match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined)
        throw invalid(`${where(path)}: ${formatPath(path)}: environment variable ${name} is not set`);
      return replacement;
    });
  }
  if (Array.isArray(value))
    return value.map((item, index) => interpolate(item, env, [...path, index], where));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, env, [...path, key], where)]),
    );
  }
  return value;
}

function fromIssues(error: z.ZodError, base: Path, where: (path: Path) => string): BridgeError {
  const issue = deepest(error.issues);
  const path = [
    ...base,
    ...(issue?.path ?? []).filter((key): key is string | number => typeof key !== 'symbol'),
  ];
  return invalid(`${where(path)}: ${formatPath(path) || '(flow)'}: ${issue?.message ?? 'invalid'}`);
}

/** For a union, zod reports one issue per option: the one that got furthest is the useful one. */
function deepest(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue | undefined {
  let best: z.core.$ZodIssue | undefined;
  for (const issue of issues) {
    const candidate =
      issue.code === 'invalid_union'
        ? deepest(issue.errors.flat().map((inner) => ({ ...inner, path: [...issue.path, ...inner.path] })))
        : issue;
    if (candidate && (!best || candidate.path.length > best.path.length)) best = candidate;
  }
  return best;
}

function formatPath(path: Path): string {
  return path.reduce<string>(
    (text, key) => (typeof key === 'number' ? `${text}[${key}]` : text === '' ? key : `${text}.${key}`),
    '',
  );
}

/** `:line` of the YAML node at `path` (or its nearest existing parent). */
function lineOf(document: Document, lines: LineCounter, path: Path): string {
  for (let depth = path.length; depth >= 0; depth--) {
    const node = document.getIn(path.slice(0, depth), true);
    if (isNode(node) && node.range) return `:${lines.linePos(node.range[0]).line}`;
  }
  return '';
}

function invalid(message: string): BridgeError {
  return new BridgeError('INVALID_PARAMS', message, { hint: 'See docs/flows.md for the flow format.' });
}
