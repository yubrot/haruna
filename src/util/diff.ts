/**
 * Line-based diff utilities using Myers' algorithm.
 *
 * @module
 */

/** An edit operation in a minimal edit script. */
export type EditOp =
  | { type: "keep"; fromIdx: number; toIdx: number }
  | { type: "delete"; fromIdx: number }
  | { type: "insert"; toIdx: number };

/** Read an Int32Array element, returning 0 for out-of-bounds access. */
function at(arr: Int32Array, idx: number): number {
  return arr[idx] ?? 0;
}

/**
 * Check whether diagonal k-1 is behind diagonal k+1 in the Myers frontier.
 * When true, the optimal move is downward (insert); otherwise rightward (delete).
 */
function shouldMoveDown(
  arr: Int32Array,
  offset: number,
  k: number,
  d: number,
): boolean {
  return (
    k === -d || (k !== d && at(arr, offset + k - 1) < at(arr, offset + k + 1))
  );
}

/**
 * Maximum edit distance before falling back to a naive all-delete-then-insert script.
 *
 * Limits the O(D * (N+M)) trace memory. At 2000, the trace array uses at most
 * ~16 MB for sequences of ~1000 elements each, which covers typical terminal
 * scrollback sizes with comfortable margin.
 */
const MAX_EDIT_DISTANCE = 2000;

/**
 * Compute a minimal edit script between two sequences using Myers' algorithm.
 *
 * O(ND) time and O(D * (N+M)) memory where N = from.length, M = to.length,
 * D = edit distance. Designed for moderate-sized sequences (terminal lines,
 * typically < 1000 elements). Falls back to a naive all-delete-then-insert
 * script when the edit distance exceeds {@link MAX_EDIT_DISTANCE}.
 *
 * @param from - Source sequence
 * @param to - Target sequence
 * @param eq - Equality function (defaults to `===`)
 * @returns An array of edit operations transforming `from` into `to`
 */
export function computeEditScript<T>(
  from: T[],
  to: T[],
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
): EditOp[] {
  const n = from.length;
  const m = to.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return to.map((_, i) => ({ type: "insert" as const, toIdx: i }));
  }
  if (m === 0) {
    return from.map((_, i) => ({ type: "delete" as const, fromIdx: i }));
  }

  // Myers' algorithm: find shortest edit path
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = n + m; // always use full range for indexing
  const size = 2 * (n + m) + 1;
  const v = new Int32Array(size);
  v.fill(-1);
  v[offset + 1] = 0;

  // Store trace for backtracking
  const trace: Int32Array[] = [];
  let solved = false;

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = new Int32Array(size);
    next.set(v);

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (shouldMoveDown(v, offset, k, d)) {
        x = at(v, offset + k + 1);
      } else {
        x = at(v, offset + k - 1) + 1;
      }

      let y = x - k;

      // Follow diagonal (matching elements)
      while (x < n && y < m && eq(from[x] as T, to[y] as T)) {
        x++;
        y++;
      }

      next[offset + k] = x;

      if (x >= n && y >= m) {
        trace[trace.length - 1] = next;
        solved = true;
        break;
      }
    }

    if (solved) break;
    v.set(next);
  }

  // Fallback: if edit distance exceeded the limit, return naive script
  if (!solved) {
    const fallback: EditOp[] = [];
    for (let i = 0; i < n; i++) fallback.push({ type: "delete", fromIdx: i });
    for (let i = 0; i < m; i++) fallback.push({ type: "insert", toIdx: i });
    return fallback;
  }

  // Backtrack to recover the edit script
  const ops: EditOp[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const k = x - y;
    const snap = trace[d] as Int32Array;

    const down = shouldMoveDown(snap, offset, k, d);
    const prevK = down ? k + 1 : k - 1;

    // Compute the starting point after the edit move (before diagonal)
    const startX = down
      ? at(snap, offset + k + 1)
      : at(snap, offset + k - 1) + 1;
    const startY = startX - k;

    // Diagonal keeps: emit in reverse, then reverse the whole array at the end
    while (x > startX && y > startY) {
      x--;
      y--;
      ops.push({ type: "keep", fromIdx: x, toIdx: y });
    }

    // The actual edit
    if (d > 0) {
      if (prevK < k) {
        x--;
        ops.push({ type: "delete", fromIdx: x });
      } else {
        y--;
        ops.push({ type: "insert", toIdx: y });
      }
    }
  }

  ops.reverse();
  return ops;
}

/**
 * Compute line-by-line diff between two plain text line arrays.
 *
 * @param from - The base lines
 * @param to - The target lines
 * @returns Unified diff as a plain text string with "+", "-", and " " prefixes
 */
export function computeLineDiff(from: string[], to: string[]): string {
  const ops = computeEditScript(from, to);
  if (!ops.some((op) => op.type !== "keep")) return "";

  const result: string[] = [];

  for (const op of ops) {
    switch (op.type) {
      case "keep":
        result.push(` ${to[op.toIdx]}`);
        break;
      case "delete":
        result.push(`-${from[op.fromIdx]}`);
        break;
      case "insert":
        result.push(`+${to[op.toIdx]}`);
        break;
    }
  }

  return result.join("\n");
}

/**
 * Collapse a unified diff string to show only lines near changes.
 *
 * Keeps `context` lines before and after each changed region, replacing
 * distant common lines with `@@ ... @@` separators (like `git diff`).
 *
 * @param diff - Full unified diff string (lines prefixed with "+", "-", or " ")
 * @param context - Number of context lines to keep around changes. `null` shows all lines.
 * @returns Collapsed diff string
 */
export function collapseDiffContext(
  diff: string,
  context: number | null,
): string {
  if (context === null || diff.length === 0) return diff;

  const lines = diff.split("\n");

  // Find indices of changed lines (non-space prefix)
  const changed = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line[0] !== " ") {
      changed.add(i);
    }
  }

  if (changed.size === 0) return diff;

  // Mark which lines to keep (changed lines + context around them)
  const keep = new Set<number>();
  for (const idx of changed) {
    for (
      let i = Math.max(0, idx - context);
      i <= Math.min(lines.length - 1, idx + context);
      i++
    ) {
      keep.add(i);
    }
  }

  // Build output with @@ separators for omitted regions
  const result: string[] = [];
  let lastIncluded = -1;

  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue;

    const gap = lastIncluded === -1 ? i : i - lastIncluded - 1;
    if (gap > 0) {
      result.push(`@@ ${gap} lines omitted @@`);
    }

    result.push(lines[i] as string);
    lastIncluded = i;
  }

  // Trailing omitted lines
  if (lastIncluded < lines.length - 1) {
    const omitted = lines.length - 1 - lastIncluded;
    result.push(`@@ ${omitted} lines omitted @@`);
  }

  return result.join("\n");
}
