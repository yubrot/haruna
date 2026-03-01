# Web Channel

HTTP server + WebSocket bridge. Serves a browser-based client on `/` and
upgrades `/ws` to a WebSocket connection.

The browser client supports an interactive mode (messages, questions,
permissions with clickable options) and a raw mode (JSON events + snapshot
text). Multiple browser tabs can connect simultaneously.

```yaml
channels:
  # Short form (all defaults)
  - web

  # Detailed form
  - type: web
    port: 7800
    host: "127.0.0.1"
    waitForClient: false
```

### Properties

| Property        | Default       | Description                           |
| --------------- | ------------- | ------------------------------------- |
| `port`          | `0` (random)  | TCP port to listen on                 |
| `host`          | `"127.0.0.1"` | Bind address                          |
| `waitForClient` | `false`       | Block startup until a client connects |

During `haruna replay`, `waitForClient` defaults to `true` so that playback
waits for an observer before starting.
