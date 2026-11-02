/**
 * Word-level diff (LCS) for showing a revision against the previously confirmed version.
 * Text is split into alternating word and whitespace tokens, so joining the `equal` + `delete`
 * segments gives `before` and joining `equal` + `insert` gives `after`. Adjacent segments with the
 * same op are merged; within a change, deletions come before insertions.
 */

export type WordDiffOp = "equal" | "insert" | "delete";
export interface WordDiffSegment {
  op: WordDiffOp;
  text: string;
}

/** Above this many LCS cells the diff degrades to "delete all, insert all". */
const MAX_CELLS = 4_000_000;

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

function push(out: WordDiffSegment[], op: WordDiffOp, text: string): void {
  const last = out[out.length - 1];
  if (last && last.op === op) last.text += text;
  else out.push({ op, text });
}

export function wordDiff(before: string, after: string): WordDiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const out: WordDiffSegment[] = [];

  // Common prefix and suffix keep the LCS table small for typical edits.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start > 0) push(out, "equal", a.slice(0, start).join(""));

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    if (n > 0) push(out, "delete", midA.join(""));
    if (m > 0) push(out, "insert", midB.join(""));
  } else if (n > 0 || m > 0) {
    // lcs[i][j] = LCS length of midA[i..] and midB[j..], flattened.
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          midA[i] === midB[j]
            ? lcs[(i + 1) * width + j + 1]! + 1
            : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    let pendingDelete = "";
    let pendingInsert = "";
    const flush = () => {
      if (pendingDelete) push(out, "delete", pendingDelete);
      if (pendingInsert) push(out, "insert", pendingInsert);
      pendingDelete = "";
      pendingInsert = "";
    };
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        flush();
        push(out, "equal", midA[i]!);
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
        pendingDelete += midA[i]!;
        i++;
      } else {
        pendingInsert += midB[j]!;
        j++;
      }
    }
    flush();
  }

  if (endA < a.length) push(out, "equal", a.slice(endA).join(""));
  return out;
}
