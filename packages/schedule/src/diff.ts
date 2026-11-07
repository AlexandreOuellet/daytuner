// A line diff of two texts, for showing what changed between two revisions of a channel file.
// Plain longest-common-subsequence: channel files are short, so nothing cleverer is needed.

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i++]! });
    } else {
      out.push({ kind: 'added', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}

/** The changed lines with `context` unchanged lines around each change, and `...` between separate changes. */
export function formatDiff(lines: readonly DiffLine[], context = 2): string {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) out.push('...');
    skipped = false;
    out.push(`${l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '} ${l.text}`);
  });
  return out.join('\n');
}
