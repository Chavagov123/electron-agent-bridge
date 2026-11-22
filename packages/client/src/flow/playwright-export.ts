import type { Action, Locator, WaitCondition } from '@electron-agent-bridge/core';

import type { Expectation, Flow, FlowStep } from './flow-schema.js';
import { describeStep } from './flow-runner.js';

/** A Playwright test generated from a flow, and what could not be carried over. */
export interface PlaywrightExport {
  readonly code: string;
  readonly warnings: readonly string[];
}

const js = (value: unknown): string => JSON.stringify(value);
/**
 * Text safe inside a `//` comment: every JavaScript line terminator ends one, and JSON does not escape
 * U+2028/U+2029, so flow text (step names, labels) could otherwise become code in the test.
 */
const oneLine = (text: string): string => text.replace(/[\r\n\u2028\u2029]/g, ' ');

/**
 * Turn a flow into a Playwright test for Electron (`_electron.launch`), so it runs without the bridge.
 * Locators map to `getByRole`/`getByText`/`locator`; checks to web-first assertions. Bridge-only parts
 * (IPC and store checks, refs, attaching to a running app) cannot be carried over: they become
 * comments, and each is listed in `warnings`.
 */
export function toPlaywright(flow: Flow): PlaywrightExport {
  const warnings: string[] = [];
  const warn = (where: string, message: string): string => {
    warnings.push(`${where}: ${message}`);
    return `// Not exported (${oneLine(message)}).`;
  };
  const launch = launchOptions(flow, warnings);
  const body: string[] = [];
  flow.steps.forEach((step, index) => {
    const where = `steps[${index}]`;
    body.push(`    // ${oneLine(step.name ?? describeStep(step))}`);
    const page = step.target ?? flow.target;
    const on = page === undefined ? 'page' : `await pageNamed(${js(page)})`;
    for (const line of stepLines(step, on, (message) => warn(where, message))) body.push(`    ${line}`);
  });
  const lines = [
    "import { _electron as electron, expect, test, type Page } from '@playwright/test';",
    '',
    `// Exported by eab from the flow ${oneLine(js(flow.name))}.`,
    `test(${js(flow.name)}, async () => {`,
    `  const app = await electron.launch(${launch});`,
    '  try {',
    '    const page = await app.firstWindow();',
    '    const consoleErrors: string[] = [];',
    "    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });",
    "    page.on('pageerror', (error) => consoleErrors.push(error.message));",
    '    /** A window by the name the bridge gave it (a slug of its file name or title). */',
    "    const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');",
    '    const pageNamed = async (name: string): Promise<Page> => {',
    '      for (const candidate of app.windows()) {',
    '        if (slug(candidate.url()).includes(name) || slug(await candidate.title()).includes(name)) return candidate;',
    '      }',
    '      return page;',
    '    };',
    ...body,
    '  } finally {',
    '    await app.close();',
    '  }',
    '});',
    '',
  ];
  return { code: lines.join('\n'), warnings };
}

function launchOptions(flow: Flow, warnings: string[]): string {
  const app = flow.app;
  if (app !== undefined && 'launch' in app) {
    const { executable, args, cwd, env } = app.launch;
    const fields = [
      `executablePath: ${js(executable)}`,
      ...(args === undefined ? [] : [`args: ${js(args)}`]),
      ...(cwd === undefined ? [] : [`cwd: ${js(cwd)}`]),
      ...(env === undefined ? [] : [`env: { ...process.env, ...${js(env)} } as Record<string, string>`]),
    ];
    return `{ ${fields.join(', ')} }`;
  }
  warnings.push(
    'app: a flow that connects to a running app is launched from EAB_EXECUTABLE and EAB_ARGS (JSON)',
  );
  return "{ executablePath: process.env['EAB_EXECUTABLE'], args: JSON.parse(process.env['EAB_ARGS'] ?? '[]') as string[] }";
}

function stepLines(step: FlowStep, on: string, warn: (message: string) => string): string[] {
  const timeout = step.timeoutMs === undefined ? '' : `timeout: ${step.timeoutMs}`;
  if (step.continueOnError === true) warn('continueOnError: a failing step still fails the test');
  if ('act' in step) {
    const actions = Array.isArray(step.act) ? step.act : [step.act];
    return actions.flatMap((action) => actionLines(action, { on, timeout, warn }));
  }
  if ('wait' in step) return [waitLine(step.wait, on, timeout, warn)];
  if ('expect' in step) return [expectLine(step.expect, on, timeout, warn)];
  if ('screenshot' in step) {
    return [`await ${on}.screenshot({ path: ${js(step.screenshot.file ?? 'screenshot.png')} });`];
  }
  if ('reset' in step) return ['// reset: nothing to undo outside the bridge.'];
  return mainProcessLines(step, warn);
}

/** Steps that act on the main process: through `app.evaluate`, as the bridge does it in-process. */
function mainProcessLines(
  step: Extract<FlowStep, { stub: unknown } | { menu: unknown } | { window: unknown }>,
  warn: (message: string) => string,
): string[] {
  if ('stub' in step) {
    if (step.stub.times !== undefined) warn('stub times: the stub stays in place');
    return [
      `await app.evaluate(({ dialog }, [method, response]) => { (dialog as unknown as Record<string, unknown>)[method] = () => Promise.resolve(response); }, ${js([step.stub.method, step.stub.response])} as const);`,
    ];
  }
  if ('menu' in step) {
    return Array.isArray(step.menu)
      ? [
          `await app.evaluate(({ Menu }, path) => { let items = Menu.getApplicationMenu()?.items ?? []; let item; for (const label of path) { item = items.find((candidate) => candidate.label === label); items = item?.submenu?.items ?? []; } item?.click(); }, ${js(step.menu)});`,
        ]
      : [
          `await app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), ${js(step.menu.id)});`,
        ];
  }
  const { action, id, bounds } = step.window;
  return [
    `await app.evaluate(({ BrowserWindow }, [id, action, bounds]) => { const window = id === null ? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] : BrowserWindow.fromId(id); if (!window) return; if (action === 'setBounds') window.setBounds(bounds ?? {}); else window[action](); }, ${js([id ?? null, action, bounds ?? null])} as const);`,
  ];
}

interface ActionContext {
  readonly on: string;
  readonly timeout: string;
  readonly warn: (message: string) => string;
}

type ActionWriter<T extends Action['type']> = (
  action: Extract<Action, { type: T }>,
  at: (locator: Locator) => string,
  options: (fields: string[]) => string,
  on: string,
) => string[];

/** One writer per action type; adding an action type without one is a type error. */
const ACTION_WRITERS: { readonly [T in Action['type']]: ActionWriter<T> } = {
  click: (action, at, options) => {
    const fields = [
      ...(action.button === undefined ? [] : [`button: ${js(action.button)}`]),
      ...(action.modifiers === undefined ? [] : [`modifiers: ${js(action.modifiers)}`]),
    ];
    if (action.clickCount === 2) return [`await ${at(action.locator)}.dblclick(${options(fields)});`];
    const count = action.clickCount === undefined ? [] : [`clickCount: ${action.clickCount}`];
    return [`await ${at(action.locator)}.click(${options([...fields, ...count])});`];
  },
  hover: (action, at, options) => [`await ${at(action.locator)}.hover(${options([])});`],
  fill: (action, at, options) => [
    `await ${at(action.locator)}.fill(${valueOf(action.value)}${withOptions(options([]))});`,
  ],
  fillForm: (action, at, options) =>
    action.fields.map((field) =>
      typeof field.value === 'boolean'
        ? `await ${at(field.locator)}.${field.value ? 'check' : 'uncheck'}(${options([])});`
        : Array.isArray(field.value)
          ? `await ${at(field.locator)}.selectOption(${js(field.value)}${withOptions(options([]))});`
          : `await ${at(field.locator)}.fill(${valueOf(field.value)}${withOptions(options([]))});`,
    ),
  type: (action, at, _options, on) => [
    ...(action.locator === undefined ? [] : [`await ${at(action.locator)}.focus();`]),
    `await (${on}).keyboard.insertText(${valueOf(action.text)});`,
  ],
  press: (action, at, options, on) =>
    action.locator === undefined
      ? [`await (${on}).keyboard.press(${js(action.key)});`]
      : [`await ${at(action.locator)}.press(${js(action.key)}${withOptions(options([]))});`],
  check: (action, at, options) => [`await ${at(action.locator)}.check(${options([])});`],
  uncheck: (action, at, options) => [`await ${at(action.locator)}.uncheck(${options([])});`],
  select: (action, at, options) => [
    `await ${at(action.locator)}.selectOption(${js(action.values)}${withOptions(options([]))});`,
  ],
  scroll: (action, at, _options, on) => [
    ...(action.locator === undefined ? [] : [`await ${at(action.locator)}.hover();`]),
    `await (${on}).mouse.wheel(${action.deltaX ?? 0}, ${action.deltaY ?? 0});`,
  ],
  upload: (action, at) => [`await ${at(action.locator)}.setInputFiles(${js(action.files)});`],
  drag: (action, at, options) => [
    `await ${at(action.from)}.dragTo(${at(action.to)}${withOptions(options([]))});`,
  ],
};

function actionLines(action: Action, { on, timeout, warn }: ActionContext): string[] {
  const options = (fields: string[]): string => {
    const all = [...fields, ...(timeout === '' ? [] : [timeout])];
    return all.length === 0 ? '' : `{ ${all.join(', ')} }`;
  };
  const at = (locator: Locator): string => locatorOf(locator, on, warn);
  // The table is keyed by the action's own type; TypeScript cannot correlate the two by itself.
  const write = ACTION_WRITERS[action.type] as ActionWriter<Action['type']>;
  return write(action, at, options, on);
}

function withOptions(options: string): string {
  return options === '' ? '' : `, ${options}`;
}

/**
 * Strings with `${env.NAME}` read the variable at test time, like the flow runner. Everything else is
 * literal: backslashes, backticks and any other `${` are escaped, so recorded text can never become code.
 */
function valueOf(value: string): string {
  const reference = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const matches = [...value.matchAll(reference)];
  if (matches.length === 0) return js(value);
  const literal = (text: string): string =>
    text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
  let out = '';
  let last = 0;
  for (const match of matches) {
    out += `${literal(value.slice(last, match.index))}\${process.env[${js(match[1])}] ?? ''}`;
    last = match.index + match[0].length;
  }
  return `\`${out}${literal(value.slice(last))}\``;
}

function locatorOf(locator: Locator, on: string, warn: (message: string) => string): string {
  const page = `(${on})`;
  const exact = locator.exact === true ? ', exact: true' : '';
  let base: string;
  if (locator.ref !== undefined) {
    warn(`ref ${locator.ref}: refs last for one page load; re-record or use role and name`);
    base = `${page}.locator(${js(`[data-eab-ref="${locator.ref}"]`)})`;
  } else if (locator.role === 'clickable') {
    base = `${page}.getByText(${js(locator.name ?? locator.text ?? '')}${exact === '' ? '' : ', { exact: true }'})`;
  } else if (locator.role !== undefined) {
    const name = locator.name ?? locator.text;
    base =
      name === undefined
        ? `${page}.getByRole(${js(locator.role)})`
        : `${page}.getByRole(${js(locator.role)}, { name: ${js(name)}${exact} })`;
  } else if (locator.text !== undefined) {
    base = `${page}.getByText(${js(locator.text)}${exact === '' ? '' : ', { exact: true }'})`;
  } else {
    base = `${page}.locator(${js(locator.css ?? '')})`;
  }
  return locator.nth === undefined ? base : `${base}.nth(${locator.nth})`;
}

function waitLine(
  condition: WaitCondition,
  on: string,
  timeout: string,
  warn: (message: string) => string,
): string {
  const options = timeout === '' ? '' : `{ ${timeout} }`;
  switch (condition.kind) {
    case 'element':
      return elementCheck(locatorOf(condition.locator, on, warn), condition.state, options);
    case 'text':
      return `await expect((${on}).getByText(${js(condition.text)}).first()).${condition.present === false ? 'toBeHidden' : 'toBeVisible'}(${options});`;
    case 'url':
      return `await expect(${on}).toHaveURL(new RegExp(${js(escapeRegExp(condition.contains))})${options === '' ? '' : `, ${options}`});`;
    case 'networkIdle':
      return `await (${on}).waitForLoadState('networkidle'${options === '' ? '' : `, ${options}`});`;
    case 'ipc':
      return warn(`wait for IPC on ${condition.channel}: Playwright cannot see the app's IPC`);
    case 'state':
      return warn(`wait for store ${condition.path}: store state is read through the bridge`);
  }
}

function expectLine(
  check: Expectation,
  on: string,
  timeout: string,
  warn: (message: string) => string,
): string {
  const options = timeout === '' ? '' : `{ ${timeout} }`;
  if ('element' in check) return elementCheck(locatorOf(check.element, on, warn), check.state, options);
  if ('text' in check)
    return waitLine(
      { kind: 'text', text: check.text, ...(check.present === undefined ? {} : { present: check.present }) },
      on,
      timeout,
      warn,
    );
  if ('url' in check) return waitLine({ kind: 'url', contains: check.url.contains }, on, timeout, warn);
  if ('noConsoleErrors' in check) return 'expect(consoleErrors).toEqual([]);';
  if ('ipc' in check) return warn(`IPC check on ${check.ipc.channel}: Playwright cannot see the app's IPC`);
  return warn(`store check ${check.state.path}: store state is read through the bridge`);
}

function elementCheck(locator: string, state: string | undefined, options: string): string {
  const matcher =
    state === 'hidden'
      ? `toBeHidden(${options})`
      : state === 'enabled'
        ? `toBeEnabled(${options})`
        : state === 'attached'
          ? `toBeAttached(${options})`
          : state === 'detached'
            ? `toBeAttached({ attached: false${options === '' ? '' : `, ${options.slice(2, -2)}`} })`
            : `toBeVisible(${options})`;
  return `await expect(${locator}).${matcher};`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
