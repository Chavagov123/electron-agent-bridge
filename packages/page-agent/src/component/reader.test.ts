// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { read } from './reader.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="root"><button id="b"><span id="icon">+</span></button></div>';
});

const el = (id: string): Element => {
  const found = document.getElementById(id);
  if (!found) throw new Error(id);
  return found;
};

function reactTree(): void {
  const app = { tag: 0, type: { name: 'App' }, memoizedProps: {}, memoizedState: null, return: null };
  const counter = {
    tag: 0,
    type: function Counter() {
      return null;
    },
    memoizedProps: { label: 'Add', children: 'x', token: 'secret' },
    // useState(3) → useRef → useReducer({ n: 1 })
    memoizedState: {
      memoizedState: 3,
      queue: {},
      next: {
        memoizedState: { current: 1 },
        queue: null,
        next: { memoizedState: { n: 1 }, queue: {}, next: null },
      },
    },
    return: app,
  };
  const memo = { tag: 14, type: { type: { displayName: 'Fancy' } }, memoizedProps: {}, return: counter };
  const host = { tag: 5, type: 'button', return: memo };
  (el('b') as unknown as Record<string, unknown>)['__reactFiber$x1'] = host;
}

describe('component reader', () => {
  it('reads React function components above an element: props, state hooks in order', () => {
    reactTree();
    expect(read(el('icon'))).toEqual({
      found: true,
      framework: 'react',
      chain: ['Fancy', 'Counter', 'App'],
      name: 'Fancy',
      value: { props: {}, hooks: [] },
      truncated: false,
    });
    expect(read(el('b'), { component: 1 })).toMatchObject({
      name: 'Counter',
      value: {
        props: { label: 'Add', children: '[children]', token: 'secret' },
        hooks: [3, { n: 1 }],
        otherHooks: 1,
      },
    });
    expect(read(el('b'), { component: 1, path: 'hooks[1].n' })).toMatchObject({ value: 1 });
  });

  it('reads class component state', () => {
    const host = {
      tag: 5,
      return: {
        tag: 1,
        type: { name: 'Clock' },
        memoizedProps: { tz: 'UTC' },
        stateNode: { state: { ticks: 2 } },
        return: null,
      },
    };
    (el('b') as unknown as Record<string, unknown>)['__reactInternalInstance$y'] = host;
    expect(read(el('b'))).toMatchObject({
      name: 'Clock',
      value: { props: { tz: 'UTC' }, state: { ticks: 2 } },
    });
  });

  it('reads Vue 3 component instances: props, setup state and data', () => {
    const root = { type: { name: 'App' }, props: {}, setupState: {}, data: {}, parent: null };
    const instance = {
      type: { __name: 'TodoItem' },
      props: { title: 'Milk' },
      setupState: { done: false, __v_skip: true },
      data: { edits: 1 },
      parent: root,
    };
    (el('b') as unknown as Record<string, unknown>)['__vueParentComponent'] = instance;
    expect(read(el('icon'))).toEqual({
      found: true,
      framework: 'vue',
      chain: ['TodoItem', 'App'],
      name: 'TodoItem',
      value: { props: { title: 'Milk' }, state: { done: false, edits: 1 } },
      truncated: false,
    });
  });

  it('says why when there is nothing to read', () => {
    expect(read(el('b'))).toMatchObject({ found: false, error: { code: 'NOT_FOUND' } });
    reactTree();
    expect(read(el('b'), { component: 5 })).toMatchObject({
      found: false,
      error: { message: 'only 3 component(s) around this element' },
    });
    expect(read(el('b'), { component: 1, path: 'props.missing' })).toMatchObject({
      found: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(read(el('b'), { path: '[' })).toMatchObject({ found: false, error: { code: 'INVALID_PARAMS' } });
    const hostile = {
      tag: 5,
      get return(): never {
        throw new Error('nope');
      },
    };
    (el('icon') as unknown as Record<string, unknown>)['__reactFiber$z'] = hostile;
    expect(read(el('icon'))).toMatchObject({ found: false, error: { code: 'INTERNAL' } });
  });
});
