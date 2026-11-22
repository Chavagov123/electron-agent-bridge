import { EventEmitter } from 'node:events';

import type { NewLogEntry } from '@eab/engine';
import { describe, expect, it } from 'vitest';

import { IpcRecorder } from './ipc-recorder.js';
import { PortCapture } from './port-capture.js';
import { UtilityCapture, type UtilityChildLike, type UtilityProcessLike } from './utility-capture.js';

class FakeChild extends EventEmitter implements UtilityChildLike {
  pid: number | undefined = undefined;
  readonly posted: unknown[][] = [];
  postMessage(...args: unknown[]): void {
    this.posted.push(args);
  }
}

function utilitySetup(): {
  module: UtilityProcessLike;
  children: FakeChild[];
  recorder: IpcRecorder;
  logs: NewLogEntry[];
  recording: { value: boolean };
  capture: UtilityCapture;
} {
  const children: FakeChild[] = [];
  const module: UtilityProcessLike = {
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  };
  const recorder = new IpcRecorder({ valueChannels: ['utility:worker'] });
  const logs: NewLogEntry[] = [];
  const recording = { value: true };
  const capture = new UtilityCapture({
    utilityProcess: module,
    recorder,
    recording,
    log: (entry) => logs.push(entry),
  });
  return { module, children, recorder, logs, recording, capture };
}

describe('UtilityCapture', () => {
  it('records what main posts and what the child sends back, and delegates unchanged', () => {
    const { module, children, recorder, logs, capture } = utilitySetup();
    capture.start();
    const child = module.fork('/app/worker.js', [], { serviceName: 'worker' }) as FakeChild;
    expect(child).toBe(children[0]);
    child.pid = 77;
    child.emit('spawn');
    child.postMessage({ job: 1 });
    const port = {};
    child.postMessage({ job: 2 }, [port]);
    child.emit('message', { done: 1 });
    expect(child.posted).toEqual([[{ job: 1 }], [{ job: 2 }, [port]]]);
    expect(
      recorder.query().items.map(({ channel, kind, side, direction, sender, values }) => ({
        channel,
        kind,
        side,
        direction,
        sender,
        values,
      })),
    ).toEqual([
      {
        channel: 'utility:worker',
        kind: 'utilityMessage',
        side: 'main',
        direction: 'out',
        sender: { target: 'u77' },
        values: [{ job: 1 }],
      },
      {
        channel: 'utility:worker',
        kind: 'utilityMessage',
        side: 'main',
        direction: 'out',
        sender: { target: 'u77' },
        values: [{ job: 2 }],
      },
      {
        channel: 'utility:worker',
        kind: 'utilityMessage',
        side: 'utility',
        direction: 'in',
        sender: { target: 'u77' },
        values: [{ done: 1 }],
      },
    ]);
    expect(logs).toEqual([{ source: 'process', level: 'info', text: 'Utility worker started (pid 77)' }]);
  });

  it('names children by module file without a service name, and stops recording after stop', () => {
    const { module, recorder, recording, capture } = utilitySetup();
    const original = module.fork;
    capture.start();
    const child = module.fork('/app/jobs/runner.js') as FakeChild;
    child.postMessage('a');
    capture.stop();
    expect(module.fork).toBe(original);
    child.postMessage('b');
    recording.value = false;
    child.emit('message', 'c');
    expect(recorder.query().items.map((event) => event.channel)).toEqual(['utility:runner.js']);
    expect(child.posted).toEqual([['a'], ['b']]);
  });

  it('stays a pass-through when another wrapper replaced fork after it, and ignores a missing module', () => {
    const { module, capture } = utilitySetup();
    capture.start();
    const later = module.fork;
    const outer: UtilityProcessLike['fork'] = (...args) => later(...args);
    module.fork = outer;
    capture.stop();
    expect(module.fork).toBe(outer);
    expect(module.fork('/x.js')).toBeInstanceOf(FakeChild);
    new UtilityCapture({
      utilityProcess: undefined,
      recorder: new IpcRecorder(),
      recording: { value: true },
      log: () => undefined,
    }).start();
  });
});

/** A MessagePortMain look-alike: an EventEmitter whose prototype has postMessage. */
class FakePort extends EventEmitter {
  peer: FakePort | undefined;
  closed = false;
  postMessage(message: unknown): void {
    this.peer?.emit('message', { data: message, ports: [] });
  }
  close(): void {
    this.closed = true;
  }
}

function channel(): { port1: FakePort; port2: FakePort } {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

describe('PortCapture', () => {
  it('records posted and received port messages with a stable id per port, then restores the prototype', () => {
    const recorder = new IpcRecorder();
    const originalPost: unknown = Object.getOwnPropertyDescriptor(FakePort.prototype, 'postMessage')?.value;
    const capture = new PortCapture({ createChannel: channel, recorder, recording: { value: true } });
    capture.start();
    const { port1, port2 } = channel();
    const received: unknown[] = [];
    port2.on('message', (event: { data: unknown }) => received.push(event.data));
    port1.postMessage({ n: 1 });
    port1.postMessage({ n: 2 });
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    const events = recorder
      .query()
      .items.map(({ channel: name, direction, argShape }) => [name, direction, argShape]);
    expect(events).toEqual([
      ['port:p1', 'out', '{n: number}[1]'],
      ['port:p2', 'in', '{n: number}[1]'],
      ['port:p1', 'out', '{n: number}[1]'],
      ['port:p2', 'in', '{n: number}[1]'],
    ]);
    expect(capture.idOf(port1)).toBe('p1');
    capture.stop();
    expect(Object.getOwnPropertyDescriptor(FakePort.prototype, 'postMessage')?.value).toBe(originalPost);
    expect(Object.prototype.hasOwnProperty.call(FakePort.prototype, 'emit')).toBe(false);
    port1.postMessage({ n: 3 });
    expect(recorder.query().items).toHaveLength(4);
    expect(received).toHaveLength(3);
  });

  it('closes its probe channel and does nothing when no channel can be made', () => {
    let probe: { port1: FakePort; port2: FakePort } | undefined;
    const capture = new PortCapture({
      createChannel: () => (probe = channel()),
      recorder: new IpcRecorder(),
      recording: { value: true },
    });
    capture.start();
    expect([probe?.port1.closed, probe?.port2.closed]).toEqual([true, true]);
    capture.stop();
    const failing = new PortCapture({
      createChannel: () => {
        throw new Error('not ready');
      },
      recorder: new IpcRecorder(),
      recording: { value: true },
    });
    failing.start();
    failing.stop();
    expect(Object.prototype.hasOwnProperty.call(FakePort.prototype, 'emit')).toBe(false);
  });
});
