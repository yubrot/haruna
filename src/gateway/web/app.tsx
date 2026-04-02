/**
 * Browser entry point for the haruna Web Gateway (multiplexing mode).
 *
 * Provides a sidebar-based multi-session interface. Each session renders a
 * {@link Terminal} connected to its own WebSocket.
 *
 * @module
 */

import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact/jsx-runtime";
import { Terminal, useDocumentTheme } from "../../channel/web/terminal.tsx";

/**
 * Root component for the gateway UI.
 *
 * Manages open tabs, each hosting a {@link Terminal} panel.
 */
function MuxApp(): JSX.Element {
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [theme, toggleTheme] = useDocumentTheme();
  const synced = useRef(false);

  // Sync tabs with server-side sessions
  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const res = await fetch("/api/sessions");
        if (!alive || !res.ok) return;
        const sessions = (await res.json()) as { id: string }[];
        const serverIds = sessions.map((s) => s.id);

        setOpenTabs((tabs) => {
          // Add server sessions not yet open locally
          const added = serverIds.filter((id) => !tabs.includes(id));
          // Remove local tabs whose sessions no longer exist on the server
          // (skip on first poll so newly created tabs aren't immediately removed)
          const merged = synced.current ? tabs.filter((id) => serverIds.includes(id)) : tabs;
          synced.current = true;
          return added.length > 0 || merged.length !== tabs.length ? [...merged, ...added] : tabs;
        });
      } catch {
        // ignore network errors
      }
    }

    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const openSession = useCallback((id: string) => {
    setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
    setActiveTab(id);
  }, []);

  const handleNewSession = useCallback(async () => {
    const id = generateId();
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    openSession(id);
  }, [openSession]);

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsBase = `${proto}//${location.host}`;

  return (
    <div class="mux-layout">
      <div class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">haruna mux</span>
          <button type="button" class="icon-btn" onClick={toggleTheme} title={`Theme: ${theme}`}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
        <div class="sidebar-sessions">
          {openTabs.map((id) => (
            <button
              key={id}
              type="button"
              class={`session-item ${activeTab === id ? "active" : ""}`}
              onClick={() => setActiveTab(id)}
              title={id}
            >
              {id}
            </button>
          ))}
          <button
            type="button"
            class="new-session-btn"
            onClick={handleNewSession}
            title="New session"
          >
            +
          </button>
        </div>
      </div>

      <div class="main-content">
        {openTabs.map((id) => (
          <div key={id} class="session-panel" hidden={activeTab !== id}>
            <Terminal wsUrl={`${wsBase}/sessions/${encodeURIComponent(id)}/ws`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Generate a random session ID (16 chars, base-36). */
function generateId(): string {
  const bytes = new Uint8Array(11);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).slice(0, 16);
}

render(<MuxApp />, document.body);
