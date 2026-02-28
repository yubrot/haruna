# haruna

**Under Development**

A TUI-agnostic bridge that wraps interactive CLI tools (Claude Code, Codex, etc.),
understands their state through pattern recognition, and bridges conversations
to Channels (Discord, Slack, ...).

Built with Bun + TypeScript.

## What haruna Does

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

## Development

### Build & Installation

```sh
bun install              # Install dependencies
bun run build            # produces out/haruna
bun run install          # build + install to ~/.local/bin
```

Produces a single-file executable. No Bun runtime required on the target
machine.
