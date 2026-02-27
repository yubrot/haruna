import { describe, expect, mock, test } from "bun:test";
import type { Scene, SceneEvent, SceneInput } from "../interface.ts";
import { CompositeScene } from "./composite.ts";

/** Create a minimal Snapshot whose first line is `text`. */
function snap(text: string) {
  return {
    lines: [text],
    cursor: { x: 0, y: 0, visible: false },
    cols: 80,
    rows: 1,
    alternate: false,
    linesOffset: 0,
    timestamp: Date.now(),
  };
}

/**
 * A stub Scene that matches snapshots whose first line starts with `prefix`.
 * Reports its `label` as the state when active.
 *
 * `firmPrefix` controls when continuation is firm: defaults to `prefix`
 * (always firm). Set to a narrower prefix to make continuation tentative
 * when the snapshot doesn't start with that prefix.
 */
function prefixScene(
  label: string,
  prefix: string,
  priority: number,
  firmPrefix?: string,
): Scene {
  const fp = firmPrefix ?? prefix;
  let active = false;
  return {
    priority,
    get state() {
      return active ? label : null;
    },
    detect(snapshot) {
      const firstLine =
        typeof snapshot.lines[0] === "string" ? snapshot.lines[0] : "";
      if (!firstLine.startsWith(prefix)) return null;
      active = true;
      return [];
    },
    continue(snapshot) {
      const firstLine =
        typeof snapshot.lines[0] === "string" ? snapshot.lines[0] : "";
      if (!firstLine.startsWith(prefix)) {
        active = false;
        return null;
      }
      return { events: [], firm: firstLine.startsWith(fp) };
    },
  };
}

describe("CompositeScene", () => {
  describe("priority", () => {
    test("tries scenes in priority order (lowest number first)", () => {
      // Both scenes match "AB…", but low-priority (0) should win
      const low = prefixScene("low", "AB", 0);
      const high = prefixScene("high", "AB", 10);
      const composite = new CompositeScene([high, low]); // intentionally reversed

      composite.process(snap("AB hello"));
      expect(composite.state).toBe("low");
    });

    test("falls through to lower-priority scene when higher does not match", () => {
      const first = prefixScene("first", "AAA", 0);
      const second = prefixScene("second", "BBB", 1);
      const composite = new CompositeScene([first, second]);

      composite.process(snap("BBB hello"));
      expect(composite.state).toBe("second");
    });
  });

  describe("continuation", () => {
    test("first match uses detect mode", () => {
      const scene = prefixScene("s", "Hello", 0);
      const composite = new CompositeScene([scene]);

      const result = composite.process(snap("Hello"));
      expect(result.events).toEqual([]);
      expect(composite.state).toBe("s");
    });

    test("subsequent matches use continuation", () => {
      const scene = prefixScene("s", "Hello", 0);
      const composite = new CompositeScene([scene]);

      composite.process(snap("Hello"));
      const result = composite.process(snap("Hello, World!"));

      expect(result.events).toEqual([]);
      expect(composite.state).toBe("s");
    });

    test("active scene is preferred over higher-priority scene during firm continuation", () => {
      const narrow = prefixScene("narrow", "Hello, World!", 0);
      const broad = prefixScene("broad", "Hello", 1);
      const composite = new CompositeScene([narrow, broad]);

      // "Hello, folks" matches only broad
      composite.process(snap("Hello, folks"));
      expect(composite.state).toBe("broad");

      // "Hello, World!" would match narrow in a fresh detect, but broad
      // is active and its firm continuation succeeds (starts with "Hello")
      const r2 = composite.process(snap("Hello, World!"));
      expect(r2.events).toEqual([]);
      expect(composite.state).toBe("broad");

      // Break continuation — broad no longer matches
      composite.process(snap("Goodbye"));

      // Fresh detect: narrow wins by priority
      composite.process(snap("Hello, World!"));
      expect(composite.state).toBe("narrow");
    });

    test("falls back to detect when continuation fails", () => {
      const scene = prefixScene("s", "Hello", 0);
      const composite = new CompositeScene([scene]);

      composite.process(snap("Hello")); // activate scene

      // Continuation fails — no match at all
      const miss = composite.process(snap("Goodbye"));
      expect(miss.events).toEqual([]);
      expect(composite.state).toBeNull();

      // Active scene was cleared; next matching process is a fresh detect
      const fresh = composite.process(snap("Hello again"));
      expect(fresh.events).toEqual([]);
      expect(composite.state).toBe("s");
    });

    test("switches to another scene after continuation fails", () => {
      const a = prefixScene("A", "Hello", 0);
      const b = prefixScene("B", "Goodbye", 1);
      const composite = new CompositeScene([a, b]);

      composite.process(snap("Hello")); // A becomes active

      // Input no longer starts with "Hello" — A continuation fails,
      // detect finds B
      const result = composite.process(snap("Goodbye"));
      expect(result.events).toEqual([]);
      expect(composite.state).toBe("B");
    });
  });

  describe("preemption", () => {
    test("tentative continue with no preemption keeps active scene", () => {
      // Shell scene: tentative when no firm prefix seen
      const shell = prefixScene("shell", "$", 10, "$ prompt");
      const composite = new CompositeScene([shell]);

      composite.process(snap("$ prompt here"));
      expect(composite.state).toBe("shell");

      // Tentative continuation (no firm prefix), but no other scene to preempt
      const result = composite.process(snap("$ running"));
      expect(result.events).toEqual([]);
      expect(composite.state).toBe("shell");
    });

    test("tentative continue preempted by another scene's detect", () => {
      const shell = prefixScene("shell", "any", 10, "any-firm");
      const vim = prefixScene("vim", "~", 0);
      const composite = new CompositeScene([vim, shell]);

      composite.process(snap("anything")); // shell activates
      expect(composite.state).toBe("shell");

      // Shell tentative (starts with "any" but not "any-firm"), vim detects "~"
      const result = composite.process(snap("~vim buffer"));
      expect(result.events).toEqual([]);
      expect(composite.state).toBe("vim");
    });

    test("firm continue skips preemption scan", () => {
      const detectSpy = mock(() => null as SceneEvent[] | null);
      const vim: Scene = {
        priority: 0,
        state: null,
        detect: detectSpy,
        continue() {
          return null;
        },
      };

      const shell = prefixScene("shell", "Hello", 10);
      const composite = new CompositeScene([vim, shell]);

      // Activate shell (vim detect returns null, shell detect matches)
      composite.process(snap("Hello world"));
      expect(composite.state).toBe("shell");

      // Reset spy after detect phase
      detectSpy.mockClear();

      // Shell continues firmly → vim.detect should NOT be called
      composite.process(snap("Hello again"));
      expect(detectSpy).not.toHaveBeenCalled();
      expect(composite.state).toBe("shell");
    });

    test("preemption does not call detect on the active scene", () => {
      const shellDetectSpy = mock(
        (snapshot: { lines: (string | object)[] }) => {
          const firstLine =
            typeof snapshot.lines[0] === "string" ? snapshot.lines[0] : "";
          if (!firstLine.startsWith("any")) return null;
          return [];
        },
      );

      let shellActive = false;
      const shell: Scene = {
        priority: 10,
        get state() {
          return shellActive ? "shell" : null;
        },
        detect: shellDetectSpy,
        continue(snapshot) {
          const firstLine =
            typeof snapshot.lines[0] === "string" ? snapshot.lines[0] : "";
          if (!firstLine.startsWith("any")) {
            shellActive = false;
            return null;
          }
          // Always tentative
          return { events: [], firm: false };
        },
      };

      const vim = prefixScene("vim", "~", 0);
      const composite = new CompositeScene([vim, shell]);

      // Activate shell
      composite.process(snap("anything"));
      shellActive = true;
      expect(composite.state).toBe("shell");

      // Clear spy after initial detect
      shellDetectSpy.mockClear();

      // Shell is tentative, preemption scan runs but should skip shell
      composite.process(snap("any text"));
      expect(shellDetectSpy).not.toHaveBeenCalled();
    });
  });

  describe("events", () => {
    test("returns events from the scene", () => {
      const events: SceneEvent[] = [
        { type: "indicator_changed", active: true, text: "Working..." },
      ];
      const scene: Scene = {
        priority: 0,
        state: null,
        detect() {
          return events;
        },
        continue() {
          return { events, firm: true };
        },
      };
      const composite = new CompositeScene([scene]);

      const result = composite.process(snap("anything"));
      expect(result.events).toEqual(events);
    });
  });

  describe("no match", () => {
    test("returns empty array when no scene matches", () => {
      const scene = prefixScene("s", "ZZZ", 0);
      const composite = new CompositeScene([scene]);

      expect(composite.process(snap("hello")).events).toEqual([]);
    });
  });

  describe("state", () => {
    test("delegates to active scene", () => {
      let currentState: string | null = null;
      const scene: Scene = {
        priority: 0,
        get state() {
          return currentState;
        },
        detect() {
          currentState = "my-state";
          return [];
        },
        continue() {
          return { events: [], firm: true };
        },
      };
      const composite = new CompositeScene([scene]);

      expect(composite.state).toBeNull();
      composite.process(snap("anything"));
      expect(composite.state).toBe("my-state");
    });

    test("returns null when no scene is active", () => {
      const composite = new CompositeScene([]);
      expect(composite.state).toBeNull();
    });
  });

  describe("Scene interface compliance", () => {
    test("has default priority", () => {
      const composite = new CompositeScene([]);
      expect(composite.priority).toBe(0);
    });

    test("accepts custom priority", () => {
      const composite = new CompositeScene([], { priority: 5 });
      expect(composite.priority).toBe(5);
    });

    test("detect delegates to child scenes", () => {
      const scene = prefixScene("s", "Hello", 0);
      const composite = new CompositeScene([scene]);

      expect(composite.detect(snap("Hello"))).toEqual([]);
      expect(composite.state).toBe("s");
      expect(composite.detect(snap("Nope"))).toBeNull();
    });

    test("continue returns null when no active scene", () => {
      const composite = new CompositeScene([prefixScene("s", "Hello", 0)]);
      expect(composite.continue(snap("Hello"))).toBeNull();
    });

    test("continue returns continuation from active child", () => {
      const scene = prefixScene("s", "Hello", 0);
      const composite = new CompositeScene([scene]);

      composite.process(snap("Hello")); // activate via process
      const result = composite.continue(snap("Hello again"));
      expect(result).not.toBeNull();
      expect(result?.firm).toBe(true);
      expect(result?.events).toEqual([]);
    });
  });

  describe("encodeInput", () => {
    test("delegates to active scene's encodeInput method", () => {
      const sendFn = mock((_input: SceneInput) => "mapped" as string | null);
      const scene: Scene = {
        priority: 0,
        state: "active",
        detect() {
          return [];
        },
        continue() {
          return { events: [], firm: true };
        },
        encodeInput: sendFn,
      };
      const composite = new CompositeScene([scene]);
      composite.process(snap("anything"));

      const result = composite.encodeInput({ type: "text", content: "hello" });
      expect(result).toBe("mapped");
      expect(sendFn).toHaveBeenCalledWith({ type: "text", content: "hello" });
    });

    test("returns null when no active scene", () => {
      const composite = new CompositeScene([]);
      expect(
        composite.encodeInput({ type: "text", content: "hello" }),
      ).toBeNull();
    });

    test("returns null when active scene has no encodeInput method", () => {
      const scene = prefixScene("s", "Hello", 0);
      const composite = new CompositeScene([scene]);
      composite.process(snap("Hello"));

      expect(
        composite.encodeInput({ type: "text", content: "hello" }),
      ).toBeNull();
    });
  });
});
