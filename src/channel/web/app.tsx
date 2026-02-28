/**
 * Browser client for the haruna Web Channel.
 *
 * Connects to the server via WebSocket, receives scene events and snapshots,
 * and provides an interactive UI for observing and sending input.
 *
 * @module
 */

import { type CSSProperties, type RefObject, render } from "preact";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "preact/hooks";
import type { JSX } from "preact/jsx-runtime";
import type { SceneEvent, SceneInput } from "../../scene/interface.ts";
import {
  computeSnapshotDiff,
  type RichSegment,
  type RichText,
  richTextToPlainText,
  type Snapshot,
} from "../../vt/snapshot.ts";
import type { Frame } from "../interface.ts";

/** Maximum number of display items / raw outputs kept in memory. */
const MAX_DISPLAY_ITEMS = 300;

type Option = { label: string; description?: string };

type DisplayItem = MessageItem | QuestionItem | PermissionItem;

interface MessageItem {
  type: "message";
  style: "text" | "block";
  content: RichText[];
}

interface QuestionItem {
  type: "question";
  header: string;
  question: string;
  options: Option[];
  selected: number;
}

interface PermissionItem {
  type: "permission";
  command: string;
  description: string;
  options: Option[];
  selected: number;
}

interface InteractiveState {
  items: DisplayItem[];
  indicator: string;
}

function useInteractiveState() {
  function init(): InteractiveState {
    return {
      items: [],
      indicator: "",
    };
  }

  function reduce(state: InteractiveState, events: SceneEvent[]) {
    let next = state;
    for (const event of events) next = applyEvent(next, event);
    if (next.items.length > MAX_DISPLAY_ITEMS) {
      next = { ...next, items: next.items.slice(-MAX_DISPLAY_ITEMS) };
    }
    return next;
  }

  return useReducer(reduce, null, init);
}

function applyEvent(
  state: InteractiveState,
  event: SceneEvent,
): InteractiveState {
  switch (event.type) {
    case "indicator_changed":
      return { ...state, indicator: event.active ? event.text : "" };
    case "message_created":
      return {
        ...state,
        items: [
          ...state.items,
          {
            type: "message",
            style: event.style,
            content: event.content,
          },
        ],
      };
    case "last_message_updated":
      return {
        ...state,
        items: updateLast(state.items, "message", (item) =>
          event.content === null
            ? null
            : {
                ...item,
                style: event.style,
                content: event.content,
              },
        ),
      };
    case "input_changed":
      return state;
    case "question_created":
      return {
        ...state,
        items: [
          ...state.items,
          {
            type: "question",
            header: event.header ?? "",
            question: event.question,
            options: event.options,
            selected: event.selected ?? -1,
          },
        ],
      };
    case "last_question_updated":
      return {
        ...state,
        items: updateLast(state.items, "question", (item) => ({
          ...item,
          header: event.header ?? "",
          question: event.question,
          options: event.options,
          selected: event.selected ?? -1,
        })),
      };
    case "permission_required":
      return {
        ...state,
        items: [
          ...state.items,
          {
            type: "permission",
            command: event.command,
            description: event.description ?? "",
            options: event.options,
            selected: event.selected ?? -1,
          },
        ],
      };
    case "scene_state_changed":
      return state;
  }
}

/**
 * Replace or remove the last item matching `type`.
 */
function updateLast<T extends DisplayItem["type"]>(
  items: DisplayItem[],
  type: T,
  updater: (
    item: Extract<DisplayItem, { type: T }>,
  ) => Extract<DisplayItem, { type: T }> | null,
): DisplayItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.type === type) {
      const item = updater(items[i] as Extract<DisplayItem, { type: T }>);
      return [
        ...items.slice(0, i),
        ...(item ? [item] : []),
        ...items.slice(i + 1),
      ];
    }
  }
  return items;
}

function richTextToHtml(rt: RichText): string {
  if (typeof rt === "string") return escapeHtml(rt);
  return rt.map(richSegmentToHtml).join("");
}

function richSegmentToHtml(seg: RichSegment): string {
  if (typeof seg === "string") return escapeHtml(seg);
  const styles: string[] = [];
  if (seg.fg !== undefined) styles.push(`color:${resolveColor(seg.fg)}`);
  if (seg.bg !== undefined) styles.push(`background:${resolveColor(seg.bg)}`);
  if (seg.b) styles.push("font-weight:bold");
  if (seg.d) styles.push("opacity:0.6");
  if (seg.i) styles.push("font-style:italic");
  if (seg.u) styles.push("text-decoration:underline");
  if (seg.s) styles.push("text-decoration:line-through");
  if (seg.v) styles.push("filter:invert(1)");
  if (seg.o) styles.push("text-decoration:overline");
  const style = styles.length > 0 ? ` style="${styles.join(";")}"` : "";
  return `<span${style}>${escapeHtml(seg.t)}</span>`;
}

function resolveColor(c: number | string): string {
  if (typeof c === "string") return c;
  if (c >= 0 && c < 16) return `var(--palette-${c})`;
  if (c >= 16 && c < 232) {
    const idx = c - 16;
    const r = Math.floor(idx / 36) * 51;
    const g = Math.floor((idx % 36) / 6) * 51;
    const b = (idx % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  if (c >= 232 && c < 256) {
    const v = (c - 232) * 10 + 8;
    return `rgb(${v},${v},${v})`;
  }
  return "inherit";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Auto-scrolls an element to the bottom when its content changes,
 * unless the user has scrolled away from the bottom.
 */
function useAutoScroll<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  const shouldScroll = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onScroll = () => {
      shouldScroll.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    };

    const observer = new MutationObserver(() => {
      if (shouldScroll.current) {
        el.scrollTop = el.scrollHeight;
      }
    });

    el.addEventListener("scroll", onScroll);
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  return ref;
}

/**
 * Manages a reconnecting WebSocket connection to the haruna server.
 * Stateless aside from connection status — received data is forwarded
 * to the caller via `onReceive`.
 */
function useChannel(onReceive: (output: Frame) => void): {
  connected: boolean;
  send: (input: SceneInput) => void;
} {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onReceiveRef = useRef(onReceive);
  onReceiveRef.current = onReceive;

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect(): void {
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (ev: MessageEvent) => {
        let output: Frame;
        try {
          output = JSON.parse(ev.data as string) as Frame;
        } catch {
          return;
        }
        onReceiveRef.current(output);
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((input: SceneInput) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(input));
    }
  }, []);

  return { connected, send };
}

/**
 * Computes inline style for windowed mode based on terminal dimensions.
 * Uses ch/lh units to approximate the terminal's cols x rows.
 */
function windowStyle(
  windowed: boolean,
  cols: number,
  rows: number,
): CSSProperties | undefined {
  if (!windowed) return undefined;
  // ch = width of '0' in monospace, lh = line height
  return {
    width: `calc(${cols}ch + 34px)`,
    height: `calc(${rows}lh + 120px)`,
    maxWidth: "100vw",
    maxHeight: "100vh",
  };
}

function App(): JSX.Element {
  const [mode, setMode] = useState<"interactive" | "raw">("interactive");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }, []);
  const [windowed, setWindowed] = useState(false);
  const [{ items, indicator }, dispatchEvents] = useInteractiveState();
  const [outputs, setFrames] = useState<Frame[]>([]);
  const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });

  const onReceive = useCallback(
    (output: Frame) => {
      setFrames((prev) => {
        const next = [...prev, output];
        return next.length > MAX_DISPLAY_ITEMS
          ? next.slice(-MAX_DISPLAY_ITEMS)
          : next;
      });
      dispatchEvents(output.events);
      setTermSize({ cols: output.snapshot.cols, rows: output.snapshot.rows });
    },
    [dispatchEvents],
  );

  const { connected, send } = useChannel(onReceive);

  const [inputText, setInputText] = useState("");
  const contentRef = useAutoScroll<HTMLDivElement>();

  const sendText = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    send({ type: "text", content: text });
    setInputText("");
  }, [inputText, send]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendText();
      }
    },
    [sendText],
  );

  return (
    <div class={windowed ? "windowed-backdrop" : ""}>
      <div
        class="shell"
        style={windowStyle(windowed, termSize.cols, termSize.rows)}
      >
        <header>
          <h1>haruna</h1>
          <span class={`status ${connected ? "connected" : "disconnected"}`}>
            {connected ? "connected" : "disconnected"}
          </span>
          <div class="controls">
            <div class="segmented">
              <button
                type="button"
                class={mode === "interactive" ? "active" : ""}
                onClick={() => setMode("interactive")}
              >
                Interactive
              </button>
              <button
                type="button"
                class={mode === "raw" ? "active" : ""}
                onClick={() => setMode("raw")}
              >
                Raw
              </button>
            </div>
            <button
              type="button"
              class="icon-btn"
              onClick={toggleTheme}
              title={`Theme: ${theme}`}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button
              type="button"
              class={`icon-btn ${windowed ? "active" : ""}`}
              onClick={() => setWindowed((v) => !v)}
              title={`Terminal: ${termSize.cols}x${termSize.rows}`}
            >
              {windowed ? "⊡" : "⊞"}
            </button>
          </div>
        </header>

        <div class="content" ref={contentRef}>
          {mode === "interactive" ? (
            <InteractiveView
              items={items}
              indicator={indicator}
              onOptionClick={(label) => send({ type: "text", content: label })}
            />
          ) : (
            <RawView outputs={outputs} />
          )}
        </div>

        <div class="input-area">
          <textarea
            rows={1}
            placeholder="Type a message..."
            value={inputText}
            onInput={(e) =>
              setInputText((e.target as HTMLTextAreaElement).value)
            }
            onKeyDown={handleKeyDown}
          />
          <button type="button" onClick={sendText}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function InteractiveView({
  items,
  indicator,
  onOptionClick,
}: {
  items: DisplayItem[];
  indicator: string;
  onOptionClick: (label: string) => void;
}): JSX.Element {
  return (
    <>
      {items.map((item, i) => (
        <DisplayItemView key={i} item={item} onOptionClick={onOptionClick} />
      ))}
      {indicator && <div class="indicator">*** {indicator} ***</div>}
    </>
  );
}

function DisplayItemView({
  item,
  onOptionClick,
}: {
  item: DisplayItem;
  onOptionClick: (label: string) => void;
}): JSX.Element | null {
  if (item.type === "message") {
    return (
      <div class={`message ${item.style}`}>
        {item.content.map((rt, i) => (
          <div
            key={i}
            dangerouslySetInnerHTML={{ __html: richTextToHtml(rt) }}
          />
        ))}
      </div>
    );
  }

  if (item.type === "question") {
    return (
      <div class="question">
        {item.header && <div class="header">{item.header}</div>}
        <div class="text">{item.question}</div>
        <OptionsList
          options={item.options}
          selected={item.selected}
          onOptionClick={onOptionClick}
        />
      </div>
    );
  }

  if (item.type === "permission") {
    return (
      <div class="permission">
        <div class="command">{item.command}</div>
        {item.description && <div class="desc">{item.description}</div>}
        <OptionsList
          options={item.options}
          selected={item.selected}
          onOptionClick={onOptionClick}
        />
      </div>
    );
  }

  return null;
}

function OptionsList({
  options,
  selected,
  onOptionClick,
}: {
  options: Option[];
  selected: number;
  onOptionClick: (label: string) => void;
}): JSX.Element {
  return (
    <ul class="options">
      {options.map((opt, i) => (
        <li
          key={i}
          class={selected === i ? "selected" : ""}
          onClick={() => onOptionClick(opt.label)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOptionClick(opt.label);
            }
          }}
        >
          <span class="label">{opt.label}</span>
          {opt.description && (
            <span class="desc-text"> — {opt.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function RawView({ outputs }: { outputs: Frame[] }): JSX.Element {
  return (
    <>
      {outputs.map((output, i) => (
        <RawEntry
          key={i}
          output={output}
          prevSnapshot={i > 0 ? (outputs[i - 1] as Frame).snapshot : null}
        />
      ))}
    </>
  );
}

function RawEntry({
  output,
  prevSnapshot,
}: {
  output: Frame;
  prevSnapshot: Snapshot | null;
}): JSX.Element {
  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());
  const [showSnapshot, setShowSnapshot] = useState(false);

  const snapshot = output.snapshot;
  const diff = prevSnapshot
    ? computeSnapshotDiff(prevSnapshot, snapshot)
    : null;

  const changedLines =
    diff?.lines?.length ?? (prevSnapshot ? null : snapshot.lines.length);
  const cursorMoved = diff?.cursor != null;

  // When exactly one line changed, show it (with cursor highlight if applicable)
  const singleChangedLine = (() => {
    if (!diff?.lines || diff.lines.length !== 1) return null;
    const [lineIdx, content] = diff.lines[0] as [number, RichText | null];
    if (content === null) return null;
    const text = richTextToPlainText(content);
    if (!text.trim()) return null;
    const cursorLineIdx = snapshot.lines.length - 1 - snapshot.cursor.y;
    const cursorCol = lineIdx === cursorLineIdx ? snapshot.cursor.x : -1;
    return { text, col: cursorCol };
  })();

  const scrolled = diff?.shift != null && diff.shift > 0;
  const totalLines = (snapshot.linesOffset ?? 0) + snapshot.lines.length;

  return (
    <div class="raw-entry">
      <div class="raw-header">
        <span class="timestamp">
          {new Date(snapshot.timestamp).toISOString()}
        </span>
        {changedLines != null && (
          <span class="raw-tag">Changed lines: {changedLines}</span>
        )}
        {prevSnapshot && cursorMoved && (
          <span class="raw-tag">Cursor moved</span>
        )}
        {scrolled && (
          <span class="raw-tag">
            {totalLines} [+{diff.shift}]
          </span>
        )}
      </div>
      {singleChangedLine && (
        <div class="raw-cursor-line">
          <CursorLine
            text={singleChangedLine.text}
            col={singleChangedLine.col}
          />
        </div>
      )}
      <div class="raw-toggles">
        {output.events.map((event, ei) => (
          <button
            key={ei}
            type="button"
            class={`raw-toggle ${event.type === "scene_state_changed" ? "accent " : ""}${expandedEvents.has(ei) ? "active" : ""}`}
            onClick={() =>
              setExpandedEvents((prev) => {
                const next = new Set(prev);
                if (next.has(ei)) next.delete(ei);
                else next.add(ei);
                return next;
              })
            }
          >
            {event.type === "scene_state_changed"
              ? `Scene: ${event.state ?? "(none)"}`
              : event.type}
          </button>
        ))}
        <button
          type="button"
          class={`raw-toggle ${showSnapshot ? "active" : ""}`}
          onClick={() => setShowSnapshot((v) => !v)}
        >
          Snapshot
        </button>
      </div>
      {output.events.map(
        (event, ei) =>
          expandedEvents.has(ei) && (
            <div key={ei} class="raw-detail">
              {JSON.stringify(event, null, 2)}
            </div>
          ),
      )}
      {showSnapshot && (
        <div class="raw-detail">{JSON.stringify(snapshot, null, 2)}</div>
      )}
    </div>
  );
}

/** Render a text line with the cursor column highlighted. */
function CursorLine({ text, col }: { text: string; col: number }): JSX.Element {
  if (col < 0 || col >= text.length) {
    return <>{text}</>;
  }
  const before = text.slice(0, col);
  const at = text[col];
  const after = text.slice(col + 1);
  return (
    <>
      {before}
      <span class="cursor-highlight">{at}</span>
      {after}
    </>
  );
}

render(<App />, document.body);
