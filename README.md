# haruna

**Under Development**: Immediate tasks

- [ ] Claude Code Scene
- [ ] Slack Channel
- [ ] Discord Channel
- [ ] Configure trust mechanism

Turn any CLI session into a live conversation.
haruna bridges any interactive CLI to any messaging platform — bidirectionally.

Built with Bun + TypeScript.

## How `haruna` works

haruna wraps an interactive CLI application (Claude Code, shell, etc.) in a
PTY and **tees** its output into a virtual terminal. The virtual terminal
produces **Snapshots** — full screen state at a point in time. Multiple
**Scene** recognition engines interpret the stream of snapshots and emit
**SceneEvents** that describe what happened semantically (e.g. "a message
was created", "input changed"). Events are delivered to **Channels**, which
bridge the CLI to external media such as Discord or Slack. Channels can also
inject input back into the PTY.

```
        Child Process (claude, shell, …)
                    ↕
 Local Terminal ←→ PTY ←── write(bytes) ─┐
                    │                    │
                    │ tee                │
                    ↓                    │
              VirtualTerminal            │
                    │                    │
                    ↓ Snapshot           │
                    │                    │
                  Scene                  │
       Scene Events ↓↑ (encodeInput)     │
                 Gateway ────────────────┘
              Frame ↓↑ Scene Inputs
         Channels (Discord, Browser, …)
```

The two key extension points are **Scene** and **Channel** — both are
interfaces, and haruna connects any combination of them agnostically.
**Gateway** orchestrates them: it feeds snapshots through scenes to
produce events (output path) and routes channel input through the active
scene's `encodeInput` to produce PTY bytes (input path).

### Scene — Pluggable Interactive CLI Recognition

A Scene classifies snapshots into semantic events. Each CLI application gets
its own Scene definition. Scenes can also implement `encodeInput` to
translate channel input into PTY byte sequences, enabling bidirectional
control. Scene definitions are loaded from a builtin registry or
user-provided `.ts` files and hot-reloaded at runtime.

### Channel — Pluggable I/O Bridge

A Channel is a bidirectional I/O interface. It receives `{ snapshot, events }`
on screen changes and can send structured input back through the Gateway.

## Usage

### `haruna [exec] [--] <command>`

Runs a command with Channels attached. The local terminal experience is
unchanged — Scene recognition and Channel delivery run behind the scenes.

```sh
# Run a command (default: $SHELL)
haruna
haruna claude
haruna -- replay   # escape hatch: run a command named "replay"
```

Behavior is controlled by the [configuration file](#configuration); without a configuration file,
no channels are enabled and haruna behaves identically to running the command directly.

### Configuration

Specifies which Scenes and Channels to enable.
haruna searches for `.haruna.yml` or `.haruna.yaml` upward from the working directory.
The config file and all dynamically loaded scene `.ts` files are watched for changes and hot-reloaded.

```yaml
# MOST IMPORTANT: Channel entries to enable.
# Each entry is a string shorthand (channel name with defaults) or an
# object with a `name` key. Default: [] (no channels)
channels:
  - dump
  - name: web
    port: 7800

# Scene entries to load.
# Each entry is a string or an object with a `src` key plus arbitrary
# per-scene properties passed to the scene's factory function.
# Entries prefixed with `!` exclude by name or glob.
# Default: ["builtin", ".haruna-scene/*.ts"]
scenes:
  - builtin # builtin alias (expands to all builtin scenes)
  - ./my-scene.ts # single file
  - .haruna-scene/*.ts # glob pattern
  - "!unwanted-scene" # exclude by name or glob
  - src: shell # object form — extra keys become per-scene properties
    prompt: "^user@name\\$"

# Virtual terminal emulator settings (values shown are defaults).
# these values are used in headless mode (e.g. `haruna record`);
# cols and rows are inherited from the local terminal during `haruna exec`.
terminal:
  cols: 80
  rows: 24
  scrollback: 500 # scrollback buffer lines
  debounceMs: 100 # min quiet time (ms) before emitting a snapshot
  maxIntervalMs: 300 # max time (ms) between snapshots even under continuous screen change
```

All top-level keys are optional. See [`src/config.ts`](src/config.ts) for the
full schema and default values.

TODO: Add minimum example

#### Environment variables substitution

Notice that config values can reference environment variables with `${VAR}` or
`${VAR:default}` syntax. Placeholders are expanded before YAML parsing,
so secrets never need to appear in the config file:

- `${VAR}` — replaced with the value of `VAR`, or empty string if unset
- `${VAR:default}` — replaced with the value of `VAR`, or `"default"` if unset

#### Scenes

##### `shell` Scene (builtin)

Recognizes interactive shell prompts.

| Property       | Default  | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `prompt`       | `"^\\$"` | Regex matching the prompt line           |
| `promptPrefix` | —        | Regex matching the line above the prompt |

When `promptPrefix` is set, the scene expects a multi-line prompt
(prefix line + prompt line).

##### Create a new Scene

A scene `.ts` file must default-export a
[`SceneFactory`](src/scene/interface.ts) — either a `Scene` object or a
factory function `(config: SceneConfig) => Scene`. The `SceneConfig`
receives reserved runtime keys (`_mode`, `_command`) plus any per-entry
properties from the config file.

See the [`haruna-scene-dev` skill](.claude/skills/haruna-scene-dev/SKILL.md) for
the full workflow — from discovery through fixture creation, implementation, testing, and iteration.

#### Channels

##### `web` Channel

HTTP server + WebSocket bridge. Serves a browser-based client on `/` and
upgrades `/ws` to WebSocket. The browser client supports an interactive
mode (messages, questions, permissions with clickable options) and a raw
mode (JSON events + snapshot text). Multiple browser tabs can connect
simultaneously.

| Property        | Default       | Description                           |
| --------------- | ------------- | ------------------------------------- |
| `port`          | `0` (random)  | TCP port to listen on                 |
| `host`          | `"127.0.0.1"` | Bind address                          |
| `waitForClient` | `false`       | Block startup until a client connects |

##### `dump` Channel

Records binary snapshots to disk. By default creates timestamped files
under `.haruna-dump/`. Setting `path` writes to a fixed file instead.

| Property | Default          | Description                                    |
| -------- | ---------------- | ---------------------------------------------- |
| `dir`    | `".haruna-dump"` | Directory for auto-named dump files            |
| `path`   | —                | Explicit file path; when set, `dir` is ignored |

##### Create a new Channel

Currently you need to modify `haruna` itself to create a new Channel. See [Development](#development).

## Development

### Build & Installation

```sh
bun install              # Install dependencies
bun run build            # produces out/haruna
bun run install          # build + install to ~/.local/bin
```

Produces a single-file executable. No Bun runtime required on the target
machine.

### Security Considerations

- **Input sanitization**: Input from Channels (e.g., Discord) is injected into the PTY
  as keystrokes. Malicious input could include control sequences (e.g., `\x03` for
  Ctrl+C, escape sequences) that disrupt the child process or execute unintended actions.
  Channel implementations must sanitize or restrict injectable input.
- **Credential management**: Secrets such as Discord Bot tokens must not be hardcoded.
  Use environment variables or a dedicated secrets manager.
- **Permission scope**: The child process inherits the haruna process's permissions.
  haruna should not be run with elevated privileges unless necessary. Channel users
  effectively have the same access as the local terminal operator.

## License

See [LICENSE](./LICENSE)
