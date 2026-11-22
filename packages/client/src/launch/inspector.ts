/** Outcome of an inspector injection. */
export type InspectorResult =
  | { readonly kind: 'injected' }
  | { readonly kind: 'unreached' }
  | { readonly kind: 'failed'; readonly reason: string };

interface Paused {
  readonly callFrames?: readonly { readonly callFrameId: string; readonly url: string }[];
  readonly data?: { readonly url?: string };
}

/** The inspector URL Node prints on stderr when started with `--inspect-brk=0`. */
export function inspectorUrl(output: string): string | undefined {
  return /Debugger listening on (ws:\/\/\S+)/.exec(output)?.[1];
}

/**
 * The app's own code, as opposed to Node's and Electron's internals: the first such script is where
 * the bridge is injected. In development that is `default_app.asar/main.js`, which runs the app.
 */
export function isUserScript(url: string): boolean {
  if (url === '' || url.startsWith('node:') || url.includes('electron/js2c')) return false;
  if (url.includes('electron.asar')) return false;
  return /\.(?:c|m)?js$/.test(url) && /^(?:file:|[A-Za-z]:[\\/]|\/)/.test(url);
}

/**
 * Inject the bridge through the Node inspector of an app started with `--inspect-brk=0`: break before
 * every script, skip internals, and at the first user script load the inject on that call frame. The
 * injected code then closes the inspector inside the app, so no debug port stays open.
 * `unreached`: the app's code never ran before `signal` aborted, or the inspector went away (the app
 * exited; the caller can tell from the process).
 */
export async function injectViaInspector(
  url: string,
  injectPath: string,
  signal: AbortSignal,
): Promise<InspectorResult> {
  const socket = new WebSocket(url);
  const pending = new Map<number, (result: unknown) => void>();
  let nextId = 0;
  const send = (method: string, params: object = {}): Promise<unknown> =>
    new Promise((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  return new Promise<InspectorResult>((resolve) => {
    let settled = false;
    /** Set once the inject ran: from then on the socket closing (the app closes it) is expected. */
    let decided: InspectorResult | undefined;
    const finish = (result: InspectorResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      socket.close();
      resolve(result);
    };
    const abort = (): void => {
      finish(decided ?? { kind: 'unreached' });
    };
    signal.addEventListener('abort', abort);
    let breakpoint = '';
    socket.addEventListener('open', () => {
      void (async () => {
        await send('Debugger.enable');
        const set = (await send('Debugger.setInstrumentationBreakpoint', {
          instrumentation: 'beforeScriptExecution',
        })) as { breakpointId?: string } | undefined;
        breakpoint = set?.breakpointId ?? '';
        await send('Runtime.runIfWaitingForDebugger');
      })();
    });
    socket.addEventListener('error', abort);
    socket.addEventListener('close', abort);
    socket.addEventListener('message', (event: { data: unknown }) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
      };
      if (message.id !== undefined) {
        pending.get(message.id)?.(message.result);
        pending.delete(message.id);
        return;
      }
      if (message.method !== 'Debugger.paused') return;
      void (async () => {
        const paused = (message.params ?? {}) as Paused;
        const frame = paused.callFrames?.[0];
        const scriptUrl = paused.data?.url ?? frame?.url ?? '';
        if (!frame || !isUserScript(scriptUrl)) {
          await send('Debugger.resume');
          return;
        }
        const evaluated = (await send('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression: injection(injectPath),
        })) as { exceptionDetails?: { exception?: { description?: string }; text?: string } } | undefined;
        const thrown = evaluated?.exceptionDetails;
        decided =
          thrown === undefined
            ? { kind: 'injected' }
            : { kind: 'failed', reason: thrown.exception?.description ?? thrown.text ?? 'the inject threw' };
        await send('Debugger.removeInstrumentationBreakpoint', { breakpointId: breakpoint });
        await send('Debugger.resume');
        finish(decided);
      })();
    });
  });
}

/** Load the inject, then close the inspector once the app runs again (no debug port left open). */
function injection(injectPath: string): string {
  const path = JSON.stringify(injectPath);
  return (
    `process.getBuiltinModule('node:module').createRequire(${path})(${path});` +
    `setTimeout(() => process.getBuiltinModule('node:inspector').close(), 0); 'injected'`
  );
}
