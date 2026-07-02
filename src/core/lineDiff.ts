/**
 * Line-based diff counting (+added / -deleted) via Myers O(ND) with a
 * bounded D. Used for tree item descriptions and the hold.minChangedLines
 * filter — counts only, no edit script needed.
 */

export interface LineDiffCounts {
  added: number;
  deleted: number;
  /** True when the diff was cut short (huge files / very divergent) and counts are approximate. */
  approximate: boolean;
}

const MAX_D = 2000;
const MAX_LINES = 50000;

export function countLineDiff(before: string, after: string): LineDiffCounts {
  if (before === after) {
    return { added: 0, deleted: 0, approximate: false };
  }
  let a = before.split('\n');
  let b = after.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return approximateCounts(a, b);
  }

  // Trim common prefix/suffix — typical edits touch a small region.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  a = a.slice(start, endA);
  b = b.slice(start, endB);

  const n = a.length;
  const m = b.length;
  if (n === 0) {
    return { added: m, deleted: 0, approximate: false };
  }
  if (m === 0) {
    return { added: 0, deleted: n, approximate: false };
  }

  // Myers: find shortest edit distance D, then deleted = (D + (n - m)) / 2.
  const max = Math.min(n + m, MAX_D);
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const deleted = (d + (n - m)) / 2;
        const added = d - deleted;
        return { added, deleted, approximate: false };
      }
    }
  }
  return approximateCounts(a, b);
}

/** Fallback when the exact diff is too expensive: multiset difference of line hashes. */
function approximateCounts(a: string[], b: string[]): LineDiffCounts {
  const counts = new Map<string, number>();
  for (const line of a) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let added = 0;
  for (const line of b) {
    const c = counts.get(line) ?? 0;
    if (c > 0) {
      counts.set(line, c - 1);
    } else {
      added++;
    }
  }
  let deleted = 0;
  for (const c of counts.values()) {
    deleted += c;
  }
  return { added, deleted, approximate: true };
}
