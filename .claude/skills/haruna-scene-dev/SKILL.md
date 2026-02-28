---
name: haruna-scene-dev
description: Design, implement, test, and debug Scene recognition engines for haruna. Covers the full lifecycle: analyzing TUI output with `haruna dump`, writing `haruna record` YAML scripts for deterministic test fixtures, implementing Scene detect/continue/encodeInput logic, and asserting with `traceScene`. Use when the user asks to create or modify a Scene, add or update scene test fixtures, debug scene recognition, or mentions haruna dump, haruna record, traceScene, scene events, or snapshot analysis.
---

# Scene Development Guide

Scenes classify VT snapshots into semantic events. This guide covers the
full development lifecycle: discover → fixture → implement → test → iterate.

## Prerequisites

### Scene Interface Contract

A Scene implements `detect()` and `continue()` against `Snapshot` objects,
emitting `SceneEvent[]`. Optionally implements `encodeInput()` to translate
channel input into PTY bytes. See @src/scene/interface.ts .

```ts
interface Scene {
  readonly priority: number; // lower = tried first
  readonly state: string | null; // diagnostic label (e.g. "shell(idle)")
  detect(snapshot): SceneEvent[] | null; // stateless initial check
  continue(snapshot): SceneContinuation | null; // stateful continuation
  encodeInput?(input: SceneInput): string | null; // channel input → PTY bytes
}

interface SceneContinuation {
  events: SceneEvent[];
  firm: boolean; // true = skip preemption, false = allow preemption scan
}

type SceneInput =
  | { type: "text"; content: string } // free-form text input
  | { type: "select"; index: number }; // option selection by 0-based index
```

#### SceneEvent Types

See `src/scene/interface.ts` for full definitions. The table below lists
events emitted by individual scenes. `scene_state_changed` is managed by
the CompositeScene orchestrator and should not be emitted by scenes directly.

| Event                   | Key fields                                      | When to emit                             |
| ----------------------- | ----------------------------------------------- | ---------------------------------------- |
| `indicator_changed`     | `active`, `text`                                | Spinner/progress indicator state change  |
| `message_created`       | `style: "text"\|"block"`, `content: RichText[]` | New output block appeared                |
| `last_message_updated`  | `style`, `content: RichText[]\|null`            | Most recent message content changed      |
| `input_changed`         | `active`, `text`                                | Input field appeared/changed/disappeared |
| `question_created`      | `question`, `options`, `selected`               | Question prompt appeared                 |
| `last_question_updated` | `question`, `options`, `selected`               | Question content changed                 |
| `permission_required`   | `command`, `options`, `selected`                | Tool permission prompt appeared          |

- `style: "block"` — like HTML `<pre>`, used for formatted texts
- `style: "text"` — like HTML `<p>`, used for plain texts
- `content` is `RichText[]` (one element per line). In tests,
  `simplifyTraceContent()` converts these to `string[]` for easier matching.

#### SceneConfig

```typescript
interface SceneConfig {
  _mode: "exec" | "replay"; // reserved: runtime mode
  _command: string[]; // reserved: command being executed
  [key: string]: unknown; // custom per-scene properties from config
}
```

Custom properties come from the config file's object-form scene entries:

```yaml
scenes:
  - src: shell
    prompt: "^\\$"
    promptPrefix: "^\\[haruna\\]$"
```

## Development Workflow

### Phase 1: Discover — Analyze the Target TUI

NOTE: This phase is typically performed by the developer manually, not by
the AI agent.

Run the target CLI tool through haruna with dump recording enabled:

```sh
haruna -- <command>     # with dump channel enabled in .haruna.yml
```

Use `haruna dump` to study the recorded session:

```sh
# Overview: stats + snapshot list
haruna dump <file>

# Search for specific screen content
haruna dump <file> --search "<regex>"

# Inspect a snapshot at a specific timestamp
haruna dump <file> --at <ts>

# Diff between snapshots
haruna dump <file> --diff              # first vs last
haruna dump <file> --diff=1            # sequential deduped diffs
haruna dump <file> --diff=2            # all frame-to-frame diffs

# With time range
haruna dump <file> --from <ts> --to <ts> --list

# Verify existing scene recognition
haruna dump <file> --at <ts> --scene
```

**Timestamp formats**: raw ms (`1771726347153`) or relative (`30s`, `1.5m`, `500ms`).

Key questions to answer during discovery:

- What visual patterns indicate state transitions?
- Where does the cursor sit in each state?
- What content appears on the cursor line vs. surrounding lines?
- How does the screen behave during alternate screen (pager, editor)?
- What happens when output exceeds the scrollback buffer?

### Phase 2: Fixture — Create Test Data

Write YAML procedure scripts for `haruna record` to capture deterministic
snapshots. Each script runs a real CLI process and captures VT state at
scripted moments.

```
haruna record <script.yml> [-o <output.dump>]
```

Output defaults to `<script-stem>.dump` in the same directory.

#### Script Format

```yaml
command: [bash, --norc, --noprofile] # required
env: # optional
  PS1: "$ "
cols: 80 # default: 80
rows: 24 # default: 24
scrollback: 24 # default: 24
steps: # required
  - wait: { content: "^\\$$" }
  - snapshot
  - input: "echo hello\n"
  - wait: { content: "^hello$" }
  - wait: { content: "^\\$$" }
  - snapshot
  - input: "exit\n"
```

#### Step Types

**`input`** — Send keystrokes to the PTY:

```yaml
- input: "echo hello\n" # Enter
- input: "\x03" # Ctrl+C
- input: "\t" # Tab
- input: "\x1b[A" # Up arrow
```

**`wait`** — Poll until condition is met:

```yaml
# Content: regex match on any screen line (ANSI-stripped plain text)
- wait: { content: "^\\$$", timeout: 10000, poll: 50 }

# Stable: screen unchanged for N ms
- wait: { stable: 500, timeout: 10000, poll: 50 }

# Cursor: cursor visibility
- wait: { cursor: { visible: true }, timeout: 10000, poll: 50 }
```

Defaults: `timeout: 10000`, `poll: 50`.

**`snapshot`** — Capture current VT state to dump. Timestamps are
deterministic: `1000 * <index>` (0, 1000, 2000, ...).

#### Fixture Design Principles

- **Deterministic prompts**: Use `bash --norc --noprofile` with `PS1="$ "` for example.
- **Minimal steps**: Capture only the snapshots needed to test state
  transitions. Fewer snapshots = easier to reason about in tests.
- **Edge case coverage**: Plan fixtures for each of these scenarios
  (where applicable to the target TUI):
  - Basic detection and state transitions
  - Scrollback overflow (output exceeds buffer)
  - Alternate screen (pager, editor)
  - Multiline input / continuation
  - In-place overwrite (`\r` progress indicators)
  - Custom configuration variants

  Example — a scrollback overflow fixture that generates output exceeding
  the buffer (`scrollback: 4` with 10 lines of output):

  ```yaml
  command: [bash, --norc, --noprofile]
  env:
    PS1: "$ "
  scrollback: 4
  steps:
    - wait: { content: "^\\$$" }
    - snapshot # idle prompt
    - input: "seq 10\n"
    - wait: { content: "^\\$$" }
    - snapshot # prompt after overflow
    - input: "exit\n"
  ```

- **Always end with exit**: Include `- input: "exit\n"` (or equivalent)
  so the child process terminates cleanly.
- **File placement**: `fixtures/<scene-name>/` directory.
  Each fixture: `<name>.yml` (script) + `<name>.dump` (recorded output).
  Add a `README.md` explaining the fixture set.

#### Troubleshooting

- **Timeout errors**: Inspect partial output with `haruna dump <output>.dump --at <last-ts>`.
  Verify regex patterns match actual screen content.
- **Non-deterministic output**: Increase `stable` wait durations. Ensure no
  user-specific config leaks (use `--norc --noprofile` or equivalents).
- **Re-recording**: After changing a script, re-run `haruna record` to
  regenerate the dump. Verify tests still pass.

### Phase 3: Implement — Write the Scene

#### File Layout

> **Note**: This guide currently targets builtin scenes (`src/scene/builtin/`).
> User-provided scenes are loaded from `.haruna-scene/*.ts` by default, but
> there is no haruna command to test them externally yet.

```
src/scene/builtin/<name>.ts       # Scene implementation
src/scene/builtin/<name>.test.ts  # Tests
src/scene/builtin/registry.ts     # Register in builtinSceneRegistry
fixtures/<name>/                  # Fixtures (.yml + .dump + README.md)
```

#### Export Pattern

The module's default export must be a `SceneFactory`:

```typescript
import type { SceneConfig } from "../interface.ts";

class MyScene implements Scene {
  readonly priority = 100;
  // ...
}

export default (config: SceneConfig) => new MyScene(config);
```

#### State Machine Design

- **Define a discriminated union** for internal state (`type` field).
- **`detect()`**: Stateless check. Return events if the scene recognizes
  the snapshot, `null` otherwise. Set internal state on match.
- **`continue()`**: Return `null` to release. Return `{ events, firm }` to
  continue. Use `firm: true` when confident (skip preemption).
  Use `firm: false` when uncertain (allow other scenes to preempt).
- **Handle `snapshot.alternate`**: Decide whether the scene operates on
  the normal screen, the alternate screen, or both. A normal-screen scene
  should yield (`{ events: [], firm: false }`) during alternate mode;
  an alternate-screen scene (e.g. pager, editor TUI) should do the
  opposite.
- **Handle `snapshot.linesOffset == null`**: Absolute positions from
  helpers use offset `0` as fallback. The scene should reset state and
  attempt re-detection within the same snapshot, since prior absolute
  positions are no longer comparable.
- **Use absolute positions**: All snapshot helpers (`cursorLineIndex`,
  `collectLines`, `findLineAbove`) work in absolute coordinates. Store
  their return values directly in scene state — no manual offset
  arithmetic needed.

#### encodeInput Implementation

`encodeInput()` is optional but enables bidirectional interaction from
channels. It receives a `SceneInput` and returns raw PTY bytes (or `null`
to decline).

```typescript
encodeInput(input: SceneInput): string | null {
  switch (input.type) {
    case "text":
      // Submit text as keystrokes + Enter
      return `${input.content}\r`;
    case "select":
      // Translate option index to key sequence
      // (e.g. arrow keys + Enter for menu navigation)
      return null; // decline if selection not supported
  }
}
```

Key considerations:

- Check the current scene state to decide what key sequences are
  appropriate. For example, a "select" input only makes sense when a
  question or permission prompt is active.
- Return `null` to decline — the gateway will skip the input silently.
- Text input has C0 control characters pre-stripped by the framework
  (see `stripControlChars` in `src/scene/interface.ts`).

#### Snapshot API Reference

From `src/vt/snapshot.ts`:

```typescript
interface Snapshot {
  lines: RichText[]; // scrollback + viewport, trailing blanks stripped
  cursor: CursorState;
  cols: number; // terminal width
  rows: number; // terminal height
  alternate: boolean; // alternate screen active (pager, editor, etc.)
  linesOffset: number | null;
  timestamp: number; // Date.now() at capture
}

interface CursorState {
  x: number; // column (0-based)
  y: number; // row from end of lines (0 = last line)
  visible: boolean; // DECTCEM
}
```

**`cursor.y`** counts from the **end** of `lines` (0 = last line, 1 =
second-to-last, ...). Do not use `cursor.y` directly to index into `lines`;
use `cursorLineIndex(snapshot)` instead, which returns the absolute index.

**`linesOffset`** is the absolute index of `lines[0]` in the virtual line
buffer. It increments when scrollback lines are evicted. Use the difference
between two snapshots' offsets to compute the shift:
`shift = curr.linesOffset - prev.linesOffset`. When `null`, tracking is
lost (e.g. terminal resized) — helpers fall back to offset `0`. Absolute
positions from such snapshots are only meaningful within the same snapshot
and must not be compared with positions from previous snapshots.

All helper functions operate in **absolute coordinates**. Scene state should
store absolute positions directly — no manual `± linesOffset` conversion
is needed.

```typescript
// Absolute line index where the cursor sits
function cursorLineIndex(snapshot: Snapshot): number;

// Single line by absolute index (undefined if out of range)
function getLine(snapshot: Snapshot, index: number): RichText | undefined;

// Slice lines in absolute range [from, to), stripping leading/trailing blanks
function collectLines(snapshot: Snapshot, from: number, to: number): RichText[];

// Search upward from `from` for a line matching `predicate`.
// Scans at most `maxLines` lines. Returns absolute index or -1.
function findLineAbove(
  snapshot: Snapshot,
  from: number,
  maxLines: number,
  predicate: (text: string) => boolean,
): number;

// Convert RichText to plain string
function richTextToPlainText(rt: RichText): string;
```

### Phase 4: Test — Assert on Scene Recognition

#### Test Structure

```typescript
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  block,
  simplifyTraceContent,
  text,
  textContaining,
  type TraceEntry,
  traceScene,
} from "../__testing.ts";
import myScene from "./my-scene.ts";

const FIXTURES_DIR = resolve(import.meta.dir, "../../../fixtures/my-scene");

async function traceMyScene(
  dumpPath: string,
  config: Record<string, unknown> = {},
): Promise<TraceEntry[]> {
  return simplifyTraceContent(
    await traceScene(
      myScene({ _mode: "replay", _command: ["..."], ...config }),
      dumpPath,
    ),
  );
}
```

**`traceScene(scene, dumpPath)`** replays a dump file through a single
scene's `detect`/`continue` methods, returning a `TraceEntry[]` — one
entry per snapshot with `{ state, firm, events }`.

**`simplifyTraceContent(trace)`** converts `RichText[]` content fields in
message events to `string[]`, enabling direct comparison with `text()` /
`block()` matchers.

#### Available Matchers

From `src/scene/__testing.ts`:

| Matcher                     | Asserts                                        |
| --------------------------- | ---------------------------------------------- |
| `text("line1", "line2")`    | `style: "text"`, exact content lines           |
| `block("line1", "line2")`   | `style: "block"`, exact content lines          |
| `textContaining("substr")`  | `style: "text"`, content includes given lines  |
| `blockContaining("substr")` | `style: "block"`, content includes given lines |
| `textMatching(/regex/)`     | `style: "text"`, at least one line matches     |
| `blockMatching(/regex/)`    | `style: "block"`, at least one line matches    |

#### Assertion Style

Use `toMatchObject` on the full trace array rather than asserting each
element individually. Key properties:

- Each element is subset-matched (extra keys in actual objects are ignored).
- The array **length must match exactly** — no `toHaveLength` needed.
- Use `{}` for elements you don't care about (matches any object).
- Use `{ events: [] }` to assert an element has zero events.

```typescript
expect(trace).toMatchObject([
  { events: [{ type: "input_changed", active: true, text: "" }] },
  {
    events: [
      { type: "input_changed", active: false, text: "" },
      block("$ echo hello"),
      text("hello"),
      { type: "input_changed", active: true, text: "" },
    ],
  },
]);
```

Use `{ state, firm }` fields to assert on scene state and firmness:

```typescript
expect(trace).toMatchObject([
  { state: "my-scene(idle)", firm: true },
  { state: "my-scene(running)", firm: false },
]);
```

### Phase 5: Verify & Iterate

```sh
bun test                                     # run all tests
bun test src/scene/builtin/<name>.test.ts    # run scene-specific tests
bun run check                                # biome lint + tsc type check
```

To verify scene recognition against existing dumps:

```sh
haruna dump <file> --scene              # list with scene classification
```

**Iteration cycle**:

1. Run tests — observe failures
2. Adjust scene logic or fixture scripts
3. Re-record fixtures if scripts changed: `haruna record <script.yml>`
4. Re-run tests
5. Repeat until all assertions pass and edge cases are covered

## Reference Implementation

The `shell` scene is the reference implementation for this workflow:

| Artifact                              | Path                              |
| ------------------------------------- | --------------------------------- |
| Scene implementation                  | `src/scene/builtin/shell.ts`      |
| Tests                                 | `src/scene/builtin/shell.test.ts` |
| Fixture scripts + dumps               | `fixtures/shell/`                 |
| Scene interface + events              | `src/scene/interface.ts`          |
| CompositeScene orchestrator           | `src/scene/builtin/composite.ts`  |
| Builtin registry                      | `src/scene/builtin/registry.ts`   |
| Test utilities (traceScene, matchers) | `src/scene/__testing.ts`          |
| Snapshot types and helpers            | `src/vt/snapshot.ts`              |
| Scene loader                          | `src/scene/loader.ts`             |
