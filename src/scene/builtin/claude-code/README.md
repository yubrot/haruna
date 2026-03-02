# Claude Code Scene

Recognizes the Claude Code TUI and emits events for messages, tool use,
questions, permissions, plan reviews, and indicator state changes.

```yaml
scenes:
  # Short form (all defaults)
  - claude-code

  # Detailed form
  - type: claude-code
```

The `claude-code` scene is included in the `builtin` alias, so it is loaded
by default unless explicitly excluded. There are no configurable properties
at this time.

## Internals

### Scene Recognization

The screen is split into two regions by a `────` separator line:

- **Content area** (above) — Scrollback containing `●` AI messages and `❯`
  user messages. Chunks are tracked across frames for incremental updates
  (`message_created` / `last_message_updated`).
- **Input area** (below) — Four layouts are recognized: free (`❯` prompt),
  question (numbered options), permission (command label + confirmation),
  and plan review (plan content between `╌╌╌╌` separators).

### States

| State                      | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `claude-code(free)`        | Standard `❯` prompt, waiting for user text input     |
| `claude-code(responding)`  | Claude is generating a response (spinner visible)    |
| `claude-code(question)`    | Numbered-option question UI (e.g. `AskUserQuestion`) |
| `claude-code(permission)`  | Tool permission prompt (e.g. "Bash command")         |
| `claude-code(plan_review)` | Plan review UI (`ExitPlanMode` confirmation)         |

### Input Encoding

- **Text input** — In `free` or `responding` state, text is typed directly
  followed by CR. In overlay states (`question`, `permission`, `plan_review`),
  ESC is sent first to dismiss the overlay before typing.
- **Select input** — When an option list is visible (`question`, `permission`,
  or `plan_review`), sends the 1-based option number as a keystroke.
