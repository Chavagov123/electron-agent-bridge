// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createAgent, type AgentResult, type SnapshotResponse } from './agent.js';

/** Small seeded PRNG (mulberry32) so failures reproduce from the printed seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ['div', 'span', 'p', 'button', 'a', 'ul', 'li', 'h2', 'input', 'label', 'section', 'nav', 'b'];
const WORDS = ['alpha', 'beta', 'gamma', 'save', 'open', 'close', 'total', 'name'];

function value(result: AgentResult<SnapshotResponse>): SnapshotResponse {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function makeElement(random: () => number): Element {
  const tag = TAGS[Math.floor(random() * TAGS.length)] ?? 'div';
  const el = document.createElement(tag);
  if (tag === 'a') el.setAttribute('href', '#');
  if (tag === 'section' || random() < 0.2)
    el.setAttribute('aria-label', WORDS[Math.floor(random() * WORDS.length)] ?? 'x');
  if (tag !== 'input' && random() < 0.7) el.textContent = WORDS[Math.floor(random() * WORDS.length)] ?? '';
  return el;
}

type Mutation = (target: Element, random: () => number, pick: () => Element) => void;

const word = (random: () => number): string => WORDS[Math.floor(random() * WORDS.length)] ?? '';

/** Mutations with cumulative probabilities. Typing changes state without any DOM mutation. */
const MUTATIONS: readonly (readonly [number, Mutation])[] = [
  [
    0.3,
    (target, random) => {
      const parent = target.tagName === 'INPUT' ? document.body : target;
      const before = parent.childNodes[Math.floor(random() * (parent.childNodes.length + 1))] ?? null;
      parent.insertBefore(makeElement(random), before);
    },
  ],
  [
    0.45,
    (target) => {
      if (target !== document.body) target.remove();
    },
  ],
  [
    0.6,
    (target, random) => {
      if (target.tagName !== 'INPUT') target.textContent = word(random);
    },
  ],
  [0.7, (target) => target.toggleAttribute('hidden')],
  [
    0.8,
    (target, random) => {
      target.setAttribute('aria-label', word(random));
    },
  ],
  [
    0.87,
    (_target, random) => {
      const input = document.querySelector('input');
      if (input) input.value = word(random);
    },
  ],
  [
    0.94,
    (target, _random, pick) => {
      const destination = pick();
      const movable =
        target !== document.body && !target.contains(destination) && destination.tagName !== 'INPUT';
      if (movable) destination.appendChild(target);
    },
  ],
  [1, (target) => target.toggleAttribute('disabled')],
];

/** One random mutation of the document. */
function mutate(random: () => number): void {
  const all = Array.from(document.body.querySelectorAll('*'));
  const pick = (): Element => all[Math.floor(random() * all.length)] ?? document.body;
  const roll = random();
  const target = pick();
  const mutation = MUTATIONS.find(([threshold]) => roll < threshold)?.[1] ?? MUTATIONS[0]![1];
  mutation(target, random, pick);
}

function seedPage(random: () => number): void {
  document.body.innerHTML = '';
  for (let index = 0; index < 25; index++) mutate(random);
}

describe('snapshot fuzzer (seeded)', () => {
  it('cached snapshots always equal a fresh rebuild, and every delta accounts for every change', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed);
      seedPage(random);
      const agent = createAgent(window, 'fuzz');
      let previous = value(agent.snapshot({}));
      for (let step = 0; step < 25; step++) {
        const count = 1 + Math.floor(random() * 3);
        for (let index = 0; index < count; index++) mutate(random);
        const delta = value(agent.snapshot({ mode: 'delta', since: previous.cursor }));
        const cached = value(agent.snapshot({}));
        const fresh = value(agent.snapshot({ fresh: true }));
        const context = `seed ${seed}, step ${step}`;
        expect(cached.text, context).toBe(fresh.text);
        checkDelta(previous.text, delta, cached.text, context);
        previous = cached;
      }
    }
  });
});

function checkDelta(previousText: string, delta: SnapshotResponse, nextText: string, context: string): void {
  const before = previousText === '' ? [] : previousText.split('\n');
  const after = nextText === '' ? [] : nextText.split('\n');
  if (delta.kind === 'unchanged') {
    expect(after, context).toEqual(before);
    return;
  }
  if (delta.kind === 'full') {
    expect(delta.text, context).toBe(nextText);
    return;
  }
  const lines = delta.text.split('\n');
  const removed = lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
  const reported = lines
    .filter((line) => line.startsWith('+ ') || line.startsWith('~ '))
    .map((line) => line.slice(2));
  const context_ = lines.filter((line) => line.startsWith('  ')).map((line) => line.slice(2));
  for (const line of removed) expect(before, `${context}: removed line existed`).toContain(line);
  for (const line of [...reported, ...context_])
    expect(after, `${context}: reported line exists`).toContain(line);
  // Everything in the new snapshot is either untouched from before or reported. Lines can repeat
  // (two `text "open"` lines), so count occurrences instead of comparing sets.
  const available = counts(before);
  for (const line of removed) available.set(line, (available.get(line) ?? 0) - 1);
  for (const line of reported) available.set(line, (available.get(line) ?? 0) + 1);
  for (const line of after) {
    const left = available.get(line) ?? 0;
    expect(left > 0, `${context}: unreported line ${line}`).toBe(true);
    available.set(line, left - 1);
  }
}

function counts(lines: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
}
