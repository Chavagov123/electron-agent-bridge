import {
  ConsoleCollector,
  LogBook,
  NetworkLog,
  type Clock,
  type RecordQueryDeps,
} from '@electron-agent-bridge/engine';
import type { App, WebContents } from 'electron';

import { MainLogCapture } from '../logs/main-logs.js';
import { WorkerStackMapper } from '../logs/worker-stack-mapper.js';
import { MainNetworkCapture, type NetLike } from '../network/main-network.js';
import type { RuntimeConfig } from './config.js';

/** What the record sources need from the host. */
export interface RecordsHost {
  readonly app: App;
  readonly allWebContents: () => WebContents[];
  readonly net?: NetLike;
}

/** The runtime's record buffers and the main-process sources that feed them. */
export interface Records {
  readonly logs: LogBook;
  readonly consoleLogs: ConsoleCollector;
  readonly network: NetworkLog;
  readonly mainLogs: MainLogCapture;
  readonly mainNetwork: MainNetworkCapture;
  /** Resolves stacks in a worker thread (absent when `logs.sourceMaps` is off); closed with the runtime. */
  readonly sourceMaps: WorkerStackMapper | undefined;
  /** What `logs.query` and `network.query` read (without the targets). */
  readonly queries: Omit<RecordQueryDeps, 'targets'>;
}

/**
 * Build the logs and network records. Nothing starts here: main logs start with the runtime, main
 * network capture with the first `network.query` (like the pages' network).
 */
export function createRecords(host: RecordsHost, config: RuntimeConfig, clock: Clock): Records {
  const logs = new LogBook();
  const consoleLogs = new ConsoleCollector(logs, clock);
  const sink = {
    begin: (...args: Parameters<NetworkLog['begin']>): void => {
      network.begin(...args);
    },
    end: (...args: Parameters<NetworkLog['end']>): void => {
      network.end(...args);
    },
  };
  const mainNetwork = new MainNetworkCapture({ sink, ...(host.net === undefined ? {} : { net: host.net }) });
  const network = new NetworkLog(clock, {
    onActivate: () => {
      mainNetwork.start();
    },
  });
  const mainLogs = new MainLogCapture({
    app: host.app,
    allWebContents: host.allWebContents,
    book: logs,
    mainConsole: config.logMainConsole,
    sources: config.logSources,
  });
  const sourceMaps = config.sourceMaps ? new WorkerStackMapper() : undefined;
  const queries = {
    logs,
    console: consoleLogs,
    network,
    ...(sourceMaps === undefined ? {} : { stacks: sourceMaps }),
  };
  return { logs, consoleLogs, network, mainLogs, mainNetwork, sourceMaps, queries };
}
