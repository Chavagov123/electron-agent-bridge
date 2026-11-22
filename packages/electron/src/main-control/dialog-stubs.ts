import { CAPS, ok, type Envelope, type MethodData, type MethodInput } from '@electron-agent-bridge/core';

type StubbedMethod = MethodInput<'dialog.stub'>['method'];
type Response = Record<string, unknown>;
type DialogFunction = (this: unknown, ...args: unknown[]) => unknown;

/** Answers queued per dialog kind; beyond this the oldest are dropped. */
const MAX_QUEUED = CAPS.maxPageItems;

/** Each stubbed dialog: its async and sync variants, the full answer and what the sync variant returns. */
const KINDS: Record<
  StubbedMethod,
  { readonly sync: string; readonly defaults: Response; readonly syncValue: (answer: Response) => unknown }
> = {
  showOpenDialog: {
    sync: 'showOpenDialogSync',
    defaults: { canceled: false, filePaths: [] },
    syncValue: (answer) => (answer['canceled'] === true ? undefined : answer['filePaths']),
  },
  showSaveDialog: {
    sync: 'showSaveDialogSync',
    defaults: { canceled: false, filePath: '' },
    syncValue: (answer) => (answer['canceled'] === true ? '' : answer['filePath']),
  },
  showMessageBox: {
    sync: 'showMessageBoxSync',
    defaults: { response: 0, checkboxChecked: false },
    syncValue: (answer) => answer['response'],
  },
};

/**
 * Queued answers for native dialogs (FR9), so a flow never blocks on one: while answers are queued for
 * a kind, the next call of that dialog (async or sync variant) returns the next answer instead of
 * showing; with none queued the app's dialog shows as usual. `restore` (session reset, controller
 * gone, bridge stopped) drops the queues and puts Electron's functions back.
 */
export class DialogStubs {
  readonly #dialog: Record<string, unknown>;
  readonly #queues = new Map<StubbedMethod, Response[]>();
  readonly #originals = new Map<string, unknown>();
  readonly #wrappers = new Map<string, DialogFunction>();

  constructor(dialog: object) {
    this.#dialog = dialog as Record<string, unknown>;
  }

  stub(input: MethodInput<'dialog.stub'>): Envelope<MethodData<'dialog.stub'>> {
    this.#install(input.method);
    const queue = this.#queues.get(input.method) ?? [];
    this.#queues.set(input.method, queue);
    const answer = { ...KINDS[input.method].defaults, ...input.response };
    // Each answer is its own copy: an app that mutates one must not change the next.
    for (let index = 0; index < (input.times ?? 1); index++) queue.push(structuredClone(answer));
    queue.splice(0, Math.max(0, queue.length - MAX_QUEUED));
    return ok({ queued: queue.length });
  }

  restore(): void {
    this.#queues.clear();
    for (const [name, original] of this.#originals) {
      if (this.#dialog[name] === this.#wrappers.get(name)) this.#dialog[name] = original;
    }
    this.#originals.clear();
    this.#wrappers.clear();
  }

  #install(method: StubbedMethod): void {
    const kind = KINDS[method];
    this.#wrap(method, (answer) => Promise.resolve(answer));
    this.#wrap(kind.sync, kind.syncValue, method);
  }

  #wrap(
    name: string,
    answerWith: (answer: Response) => unknown,
    kind: StubbedMethod = name as StubbedMethod,
  ): void {
    const original = this.#dialog[name];
    if (this.#wrappers.has(name) || typeof original !== 'function') return;
    const queues = this.#queues;
    const call = original as DialogFunction;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const answer = queues.get(kind)?.shift();
      return answer === undefined ? call.apply(this, args) : answerWith(answer);
    };
    this.#originals.set(name, original);
    this.#wrappers.set(name, wrapper);
    this.#dialog[name] = wrapper;
  }
}
