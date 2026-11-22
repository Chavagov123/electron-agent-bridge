import {
  LIMITATION_CODES,
  droppedLimitation,
  ok,
  type Envelope,
  type Limitation,
  type MethodData,
  type MethodInput,
} from '@eab/core';

import { MAX_CHANNELS, type IpcRecorder } from './ipc-recorder.js';

/** `ipc.query`: one page of recorded messages plus the channel catalogue, with what was lost. */
export function queryIpc(
  recorder: IpcRecorder,
  input: MethodInput<'ipc.query'>,
): Envelope<MethodData<'ipc.query'>> {
  const { channelsDropped, ...page } = recorder.query({
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.includeInternal === undefined ? {} : { includeInternal: input.includeInternal }),
    ...(input.schemas === undefined ? {} : { schemas: input.schemas }),
  });
  const limitations: Limitation[] = [];
  const dropped = droppedLimitation('IPC messages', page.dropped);
  if (dropped) limitations.push(dropped);
  if (channelsDropped > 0) {
    limitations.push({
      code: LIMITATION_CODES.truncated,
      message: `${channelsDropped} message(s) were on channels beyond the ${MAX_CHANNELS}-channel catalogue.`,
    });
  }
  return ok(page, limitations);
}
