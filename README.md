# haruna

**Under Development**: Immediate tasks

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

# `haruna [exec] [--] <command>`

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

## Configuration

Specifies which Scenes and Channels to enable.
haruna searches for `.haruna.yml` or `.haruna.yaml` upward from the working directory,
or uses the file specified by `-c` / `--config`.
The config file and all dynamically loaded scene `.ts` files are watched for changes and hot-reloaded.

All top-level keys are optional. See [`src/config.ts`](src/config.ts) for the
full schema and default values.

### `channels`

Channel entries to enable. Each entry is a string shorthand (channel type with
defaults) or an object with a `type` key.

```yaml
# Default: [] (no channels)
channels:
  - dump
  - type: web
    port: 7800
```

List of available channel types:

- [`slack`](src/channel/slack/README.md) — Connects Slack
- [`discord`](src/channel/discord/README.md) — Connects Discord
- [`web`](src/channel/web/README.md) — HTTP server + WebSocket bridge. Serves a browser-based client and streams events via WebSocket
- [`dump`](src/channel/dump/README.md) — Records binary snapshots to disk for scene development and debugging

### `scenes`

Scene entries to load. Each entry is a string or an object with a `type` key
plus arbitrary per-scene properties passed to the scene's factory function.
Entries prefixed with `!` exclude by name or glob.

```yaml
# Default: ["builtin", ".haruna-scene/*.ts"]
scenes:
  - builtin # builtin alias (expands to all builtin scenes)
  - ./my-scene.ts # single file
  - .haruna-scene/*.ts # glob pattern
  - "!unwanted-scene" # exclude by name or glob
  - type: shell # object form — extra keys become per-scene properties
    prompt: "^user@name\\$"
```

List of available scene types:

- [`shell`](src/scene/builtin/shell/README.md) — Recognizes interactive shell prompts
- [`claude-code`](src/scene/builtin/claude-code/README.md) — Recognizes Claude Code CLI sessions

### `terminal`

Virtual terminal emulator settings (values shown are defaults). These values are
used in headless mode (e.g. `haruna record`); cols and rows are inherited from
the local terminal during `haruna exec`.

```yaml
terminal:
  cols: 80
  rows: 24
  scrollback: 500 # scrollback buffer lines
  debounceMs: 100 # min quiet time (ms) before emitting a snapshot
  maxIntervalMs: 300 # max time (ms) between snapshots even under continuous screen change
```

### Environment variables substitution

Notice that config values can reference environment variables with `${VAR}` or
`${VAR:default}` syntax. Placeholders are expanded before YAML parsing,
so secrets never need to appear in the config file:

- `${VAR}` — replaced with the value of `VAR`, or empty string if unset
- `${VAR:default}` — replaced with the value of `VAR`, or `"default"` if unset

# Development

## Build & Installation

```sh
bun install              # Install dependencies
bun run build            # produces out/haruna
bun run install          # build + install to ~/.local/bin
```

Produces a single-file executable. No Bun runtime required on the target
machine.

## How-to

### Create a new Scene

A scene `.ts` file must default-export a
[`SceneFactory`](src/scene/interface.ts) — either a `Scene` object or a
factory function `(config: SceneConfig) => Scene`. The `SceneConfig`
receives reserved runtime keys (`_mode`, `_command`) plus any per-entry
properties from the config file.

See the [`haruna-scene-dev` skill](.claude/skills/haruna-scene-dev/SKILL.md) for
the full workflow — from discovery through fixture creation, implementation, testing, and iteration.

### Create a new Channel

Currently you need to modify `haruna` itself to create a new Channel. See [Development](#development).

## Security Considerations

- **Input sanitization**: Input from Channels (e.g., Discord) is injected into the PTY
  as keystrokes. Malicious input could include control sequences (e.g., `\x03` for
  Ctrl+C, escape sequences) that disrupt the child process or execute unintended actions.
  Channel implementations must sanitize or restrict injectable input.
- **Credential management**: Secrets such as Discord Bot tokens must not be hardcoded.
  Use environment variables or a dedicated secrets manager.
- **Permission scope**: The child process inherits the haruna process's permissions.
  haruna should not be run with elevated privileges unless necessary. Channel users
  effectively have the same access as the local terminal operator.

---

[LICENSE](./LICENSE)
