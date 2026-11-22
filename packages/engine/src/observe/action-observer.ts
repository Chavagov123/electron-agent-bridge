import type { Observations } from '@electron-agent-bridge/core';
import type { LiveState } from '@electron-agent-bridge/page-agent';
import { z } from 'zod';

import type { PageAgentClient } from '../page/page-agent-client.js';
import type { CdpEvent, Disposable } from '../ports/cdp-transport.js';
import type { IpcFeed } from '../ports/ipc-feed.js';
import { safeUrl } from './url-privacy.js';

/** Items kept per observation list; one action rarely causes more, and agents need the gist. */
const MAX_ITEMS = 10;
const MAX_TEXT = 200;

const ConsoleCall = z.object({
  type: z.string(),
  args: z.array(z.object({ value: z.unknown().optional(), description: z.string().optional() })),
});
const ExceptionThrown = z.object({
  exceptionDetails: z.object({
    text: z.string(),
    exception: z.object({ description: z.string().optional() }).optional(),
  }),
});
const RequestSent = z.object({ requestId: z.string(), request: z.object({ url: z.string() }) });
const LoadingFailed = z.object({
  requestId: z.string(),
  errorText: z.string(),
  canceled: z.boolean().optional(),
});
const ResponseReceived = z.object({
  requestId: z.string(),
  response: z.object({ url: z.string(), status: z.number() }),
});
const FrameNavigated = z.object({ frame: z.object({ url: z.string(), parentId: z.string().optional() }) });

/**
 * Watches one page while actions run and reports their effects (the cause→effect trace): console
 * errors, failed requests, main-frame navigation, new live-region text (toasts) and new dialogs.
 */
export class ActionObserver {
  readonly #client: PageAgentClient;
  readonly #consoleErrors: string[] = [];
  readonly #failedRequests: string[] = [];
  readonly #urls = new Map<string, string>();
  #navigation: string | undefined;
  #subscription: Disposable | undefined;
  /** Live regions and dialogs at the last sample; what differs at the next one was caused by the step. */
  #last: LiveState = { regions: {}, dialogs: [] };
  readonly #toasts: string[] = [];
  readonly #dialogs: string[] = [];

  readonly #ipc: IpcFeed | undefined;
  #ipcFrom = 0;

  constructor(client: PageAgentClient, ipc?: IpcFeed) {
    this.#client = client;
    this.#ipc = ipc;
  }

  async start(): Promise<void> {
    // Events flow only for enabled domains; both stay on for the session (lazily, on first action).
    this.#client.ensure('Network.enable');
    this.#client.ensure('Page.enable');
    // Read the page first: the agent's bootstrap enables Runtime, which replays console messages logged
    // earlier. Subscribing afterwards keeps those out of what the action caused.
    this.#last = await this.#client.invoke<LiveState>('live', []);
    this.#ipcFrom = this.#ipc?.lastSeq() ?? 0;
    this.#subscription = this.#client.transport.onEvent((event) => {
      this.#onEvent(event);
    });
  }

  /**
   * Record live-region text and dialogs that appeared since the last sample. Called after every step,
   * so a toast replaced by the next step's toast (one reused region) is still reported.
   */
  async sample(): Promise<void> {
    const now = await this.#client.invoke<LiveState>('live', []).catch(() => undefined);
    if (now) this.record(now);
  }

  /** Take a live state read elsewhere (with a step's settling) as the next sample. */
  record(now: LiveState): void {
    for (const [ref, text] of Object.entries(now.regions)) {
      if (this.#last.regions[ref] !== text) addOnce(this.#toasts, text);
    }
    for (const dialog of now.dialogs) {
      if (!this.#last.dialogs.includes(dialog)) addOnce(this.#dialogs, dialog);
    }
    this.#last = now;
  }

  /** `sampled`: the page was just sampled (after the last step), so it is not read again. */
  async finish(options: { readonly sampled?: boolean } = {}): Promise<Observations> {
    if (options.sampled !== true) await this.sample();
    this.#subscription?.dispose();
    return {
      dialogs: this.#dialogs.slice(0, MAX_ITEMS),
      toasts: this.#toasts.slice(0, MAX_ITEMS),
      consoleErrors: this.#consoleErrors.slice(0, MAX_ITEMS),
      failedRequests: this.#failedRequests.slice(0, MAX_ITEMS),
      ipc: (this.#ipc?.since(this.#ipcFrom, MAX_ITEMS).items ?? []).map(({ seq, channel, kind }) => ({
        seq,
        channel,
        kind,
      })),
      ...(this.#navigation === undefined ? {} : { navigation: { url: this.#navigation } }),
    };
  }

  #onEvent(event: CdpEvent): void {
    if (event.sessionId !== undefined) return;
    switch (event.method) {
      case 'Runtime.consoleAPICalled':
        this.#console(event.params);
        break;
      case 'Runtime.exceptionThrown': {
        const parsed = ExceptionThrown.safeParse(event.params);
        if (parsed.success) {
          const details = parsed.data.exceptionDetails;
          this.#consoleErrors.push(clip(details.exception?.description ?? details.text));
        }
        break;
      }
      case 'Network.requestWillBeSent': {
        const parsed = RequestSent.safeParse(event.params);
        if (parsed.success) this.#urls.set(parsed.data.requestId, parsed.data.request.url);
        break;
      }
      default:
        this.#network(event);
    }
  }

  #console(params: unknown): void {
    const parsed = ConsoleCall.safeParse(params);
    if (!parsed.success || (parsed.data.type !== 'error' && parsed.data.type !== 'assert')) return;
    const text = parsed.data.args.map((arg) => arg.description ?? String(arg.value)).join(' ');
    this.#consoleErrors.push(clip(text));
  }

  #network(event: CdpEvent): void {
    if (event.method === 'Network.loadingFailed') {
      const parsed = LoadingFailed.safeParse(event.params);
      if (parsed.success && parsed.data.canceled !== true) {
        const url = this.#urls.get(parsed.data.requestId) ?? parsed.data.requestId;
        this.#failedRequests.push(clip(`${parsed.data.errorText} ${safeUrl(url)}`));
      }
    } else if (event.method === 'Network.responseReceived') {
      const parsed = ResponseReceived.safeParse(event.params);
      if (parsed.success && parsed.data.response.status >= 400) {
        this.#failedRequests.push(
          clip(`${parsed.data.response.status} ${safeUrl(parsed.data.response.url)}`),
        );
      }
    } else if (event.method === 'Page.frameNavigated') {
      const parsed = FrameNavigated.safeParse(event.params);
      if (parsed.success && parsed.data.frame.parentId === undefined)
        this.#navigation = parsed.data.frame.url;
    }
  }
}

function addOnce(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}
