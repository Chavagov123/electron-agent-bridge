import { formatLine, type Line } from './render.js';

export interface Delta {
  /** `+` added, `~` changed, `-` removed; unmarked lines are unchanged context (ancestors). */
  readonly text: string;
  readonly changes: number;
}

/**
 * Lines that differ between two renders of the same scope, keyed by element ref / text id.
 * Each changed line is preceded by its unchanged ancestors (as context) so the agent knows where it is.
 */
export function diffLines(previous: readonly Line[], next: readonly Line[]): Delta {
  const before = new Map(previous.map((line) => [line.key, line]));
  const marks = next.map((line) => {
    const old = before.get(line.key);
    if (!old) return '+';
    // "… N more" only counts what stays collapsed: not a change of the page.
    if (line.key.endsWith(':more')) return ' ';
    return old.text === line.text && old.depth === line.depth ? ' ' : '~';
  });
  const nextKeys = new Set(next.map((line) => line.key));
  const removed = previous.filter((line) => !nextKeys.has(line.key) && !line.key.endsWith(':more'));

  const out: string[] = [];
  const printed = new Set<number>();
  const printContext = (index: number): void => {
    const line = next[index];
    if (!line || printed.has(index)) return;
    printContext(line.parent);
    printed.add(index);
    out.push(`  ${formatLine(line)}`);
  };
  let changes = removed.length;
  next.forEach((line, index) => {
    const mark = marks[index];
    if (mark === ' ') return;
    changes++;
    printContext(line.parent);
    printed.add(index);
    out.push(`${mark ?? '+'} ${formatLine(line)}`);
  });
  for (const line of removed) out.push(`- ${formatLine(line)}`);
  return { text: out.join('\n'), changes };
}
