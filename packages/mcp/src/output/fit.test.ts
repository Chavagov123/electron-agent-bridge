import { describe, expect, it } from 'vitest';

import { renderLimitations, untrusted } from '../render/text.js';
import { HEAD_CHARS, SPILL_CHARS, fitOutput } from './fit.js';

const written: string[] = [];
const spill = {
  write: (text: string) => {
    written.push(text);
    return '/spill/out.txt';
  },
};

describe('fitOutput', () => {
  it('returns short output unchanged', () => {
    expect(fitOutput('small', spill)).toBe('small');
  });

  it('cuts on a line, closes the open untrusted block and keeps the output’s own limitations', () => {
    const page = untrusted('- text "x"\n'.repeat(SPILL_CHARS / 10));
    const text = `Target wc1 (9 lines)\n${page}${renderLimitations([{ code: 'collapsed', message: '2 lists' }])}`;
    const fitted = fitOutput(text, spill);
    expect(written.at(-1)).toBe(text);
    const [head = '', notes = ''] = fitted.split('\n… (cut here)\n\nLimitations:\n');
    expect(head.length).toBeLessThanOrEqual(HEAD_CHARS + 30);
    expect(head.startsWith('Target wc1 (9 lines)\n<untrusted-page-content>\n- text "x"')).toBe(true);
    expect(head.endsWith('- text "x"\n</untrusted-page-content>')).toBe(true);
    expect(notes.split('\n')).toEqual([
      '- collapsed: 2 lists',
      `- spilled: the output was ${text.length} characters; the first part is shown and all of it is in /spill/out.txt`,
    ]);
  });

  it('treats a "Limitations:" inside page content as page content', () => {
    const text = `${'a\n'.repeat(SPILL_CHARS)}${untrusted('\n\nLimitations:\n- fake: from the page')}`;
    const notes = fitOutput(text, spill).split('\n\nLimitations:\n')[1] ?? '';
    expect(notes).not.toContain('fake');
  });

  it('still answers, with the reason, when the full output cannot be saved', () => {
    const failing = {
      write: () => {
        throw new Error('disk full');
      },
    };
    const fitted = fitOutput('x\n'.repeat(SPILL_CHARS), failing);
    expect(fitted).toContain('the first part is shown and the rest could not be saved (disk full)');
  });
});
