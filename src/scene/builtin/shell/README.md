# Shell Scene

Recognizes interactive shell prompts and emits events for command execution,
output, and input state changes.

The scene matches a configurable regex against the cursor line. When the
prompt is visible, the scene is in **idle** state and reports user input via
`input_changed`. When the prompt disappears (command execution), it
transitions to **running** and emits `message_created` events for prompt
blocks and command output.

```yaml
scenes:
  # Short form (all defaults)
  - shell

  # Detailed form
  - type: shell
    prompt: "^\\$"
    promptPrefix: "^\\[haruna\\]$" # optional, for multi-line prompts
```

The `shell` scene is included in the `builtin` alias, so it is loaded by
default unless explicitly excluded.

### Properties

| Property       | Default  | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `prompt`       | `"^\\$"` | Regex matching the prompt line           |
| `promptPrefix` | —        | Regex matching the line above the prompt |

When `promptPrefix` is set, the scene expects a two-line prompt block
(prefix line + prompt line). For example, the config above matches:

```
[haruna]
$ echo "Hello"
```

## States

| State            | Description                                   |
| ---------------- | --------------------------------------------- |
| `shell(idle)`    | Prompt visible, waiting for user input        |
| `shell(running)` | Command executing, prompt no longer at cursor |
