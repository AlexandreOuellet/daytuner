import { describe, expect, it } from 'vitest';
import { diffLines, formatDiff } from './diff.js';

describe('diffLines', () => {
  it('finds changed, added and removed lines', () => {
    const d = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(d.map((l) => `${l.kind[0]}:${l.text}`)).toEqual(['s:a', 'r:b', 'a:B', 's:c', 'a:d']);
  });
  it('reports no change for equal texts, and handles empty ones', () => {
    expect(diffLines('x\ny\n', 'x\ny\n').every((l) => l.kind === 'same')).toBe(true);
    expect(diffLines('', 'x\n')).toEqual([{ kind: 'added', text: 'x' }]);
    expect(diffLines('x\n', '')).toEqual([{ kind: 'removed', text: 'x' }]);
  });
});

describe('formatDiff', () => {
  it('shows context around changes and elides the rest', () => {
    const before = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n') + '\n';
    const after = before.replace('line1\n', 'ONE\n').replace('line10\n', 'TEN\n');
    const text = formatDiff(diffLines(before, after), 1);
    expect(text).toBe(['  line0', '- line1', '+ ONE', '  line2', '...', '  line9', '- line10', '+ TEN', '  line11'].join('\n'));
  });
});
