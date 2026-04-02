# Web Gateway

HTTP + WebSocket gateway for multiplexing mode. Serves a lobby page listing
active sessions and per-session browser clients backed by the shared
[Web UI](../../web/).

Sessions are created on demand when a WebSocket client first connects. Multiple
browser tabs can view the same session simultaneously.

```yaml
gateways:
  # Short form (all defaults)
  - web

  # Detailed form
  - type: web
    port: 7800
    host: "127.0.0.1"
```

### Properties

| Property | Default       | Description           |
| -------- | ------------- | --------------------- |
| `port`   | `0` (random)  | TCP port to listen on |
| `host`   | `"127.0.0.1"` | Bind address          |

### Routes

| Method | Path               | Description                             |
| ------ | ------------------ | --------------------------------------- |
| GET    | `/`                | Lobby page (session list + new session) |
| GET    | `/api/sessions`    | JSON array of active sessions           |
| POST   | `/api/sessions`    | Create a session (`{ "id": "..." }`)    |
| WS     | `/sessions/:id/ws` | Per-session WebSocket (Frame broadcast) |

### Session lifecycle

1. Browser creates a session via `POST /api/sessions` and connects via WebSocket
2. Gateway creates a `WebSessionChannel` and calls `SessionManager.request(id, channel)`
3. The Multiplexer creates (or reuses) a session and attaches the channel
4. Frames are broadcast to all WebSocket clients viewing that session
5. When the session's PTY process exits, the Multiplexer destroys the session and the gateway closes all connected clients
